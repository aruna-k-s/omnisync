#!/usr/bin/env python3
"""
Preflight renderer for the OmniSync Helm chart. Spec: docs/specs/deployment.md ("What is proven where").

It implements the Go text/template subset (plus the handful of Helm/sprig functions) that the chart restricts itself to,
so the templates can be rendered, schema-validated and checked with kubeconform where Helm cannot be downloaded. It is not
a replacement for Helm: CI runs `helm lint` and `helm template` too, and where the two disagree Helm is right.

    render_chart.py CHART_DIR [-f values.yaml]... [--set a.b=c]... [--release NAME] [--namespace NS]

prints the rendered manifests as one multi-document YAML stream.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
from typing import Any, Callable

import yaml


class TemplateError(Exception):
    pass


# ----------------------------------------------------------------------------------------------------------------
# values and printing, as Go does them


def truthy(v: Any) -> bool:
    if v is None or v is False:
        return False
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v != 0
    if isinstance(v, (str, list, dict, tuple)):
        return len(v) > 0
    return True


def fmt(v: Any) -> str:
    if v is None:
        return ""  # Helm removes "<no value>"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, float):
        return str(int(v)) if v == int(v) else repr(v)
    if isinstance(v, list):
        return "[" + " ".join(fmt(x) for x in v) + "]"
    if isinstance(v, dict):
        return "map[" + " ".join(f"{k}:{fmt(v[k])}" for k in sorted(v)) + "]"
    return str(v)


def to_yaml(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, (dict, list)):
        if not v:
            return "{}" if isinstance(v, dict) else "[]"
        return yaml.safe_dump(v, default_flow_style=False, sort_keys=True, width=100000, allow_unicode=True).rstrip("\n")
    return fmt(v)


def go_quote(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)


def go_printf(f: str, *args: Any) -> str:
    out: list[str] = []
    it = iter(args)
    i = 0
    while i < len(f):
        c = f[i]
        if c != "%":
            out.append(c)
            i += 1
            continue
        m = re.match(r"%([-+# 0]*)(\d*)(?:\.(\d+))?([sdvqt%])", f[i:])
        if not m:
            raise TemplateError(f"printf: unsupported verb in {f!r}")
        flags, width, prec, verb = m.groups()
        i += m.end()
        if verb == "%":
            out.append("%")
            continue
        try:
            a = next(it)
        except StopIteration:
            raise TemplateError("printf: too few arguments") from None
        s = {"s": fmt, "v": fmt, "d": lambda x: str(int(x)), "q": lambda x: go_quote(fmt(x)), "t": fmt}[verb](a)
        if prec is not None and verb == "s":
            s = s[: int(prec)]
        if width:
            s = s.ljust(int(width)) if "-" in flags else s.rjust(int(width), "0" if "0" in flags and verb == "d" else " ")
        out.append(s)
    return "".join(out)


# ----------------------------------------------------------------------------------------------------------------
# parsing

_STR = r'"(?:[^"\\]|\\.)*"'
_RAW = r"`[^`]*`"
_TOKEN = re.compile(
    rf"\s*(?:(?P<str>{_STR})|(?P<raw>{_RAW})|(?P<num>-?\d+(?:\.\d+)?(?![\w.]))|(?P<var>\$(?:[A-Za-z_]\w*)?(?:\.[A-Za-z_]\w*)*)"
    r"|(?P<field>\.(?:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)?)|(?P<ident>[A-Za-z_]\w*)|(?P<op>:=|=|\||\(|\)|,))"
)


class Node:
    pass


class Text(Node):
    def __init__(self, s: str):
        self.s = s


class Action(Node):
    def __init__(self, pipe):
        self.pipe = pipe


class If(Node):
    def __init__(self, pipe, body, els):
        self.pipe, self.body, self.els = pipe, body, els


class With(If):
    pass


class Range(Node):
    def __init__(self, vars_, pipe, body, els):
        self.vars, self.pipe, self.body, self.els = vars_, pipe, body, els


class TemplateCall(Node):
    def __init__(self, name, pipe):
        self.name, self.pipe = name, pipe


class Pipe:
    def __init__(self, decl, assign, cmds):
        self.decl, self.assign, self.cmds = decl, assign, cmds  # decl: list of variable names or None


def _scan(src: str) -> list[tuple[str, str]]:
    """Splits into ('text', s) and ('action', body) with the trim markers already applied to the neighbouring text."""
    toks: list[list[str]] = []
    i = 0
    n = len(src)
    while i < n:
        j = src.find("{{", i)
        if j < 0:
            toks.append(["text", src[i:]])
            break
        if j > i:
            toks.append(["text", src[i:j]])
        k = j + 2
        ltrim = src[k : k + 2] in ("- ", "-\t", "-\n", "-\r")
        if ltrim:
            k += 1
        # find the closing "}}" outside strings
        m = k
        while m < n:
            c = src[m]
            if c == '"':
                m += 1
                while m < n and src[m] != '"':
                    m += 2 if src[m] == "\\" else 1
                m += 1
            elif c == "`":
                m = src.find("`", m + 1)
                if m < 0:
                    raise TemplateError("unterminated raw string")
                m += 1
            elif src.startswith("/*", m):
                e = src.find("*/", m + 2)
                if e < 0:
                    raise TemplateError("unterminated comment")
                m = e + 2
            elif src.startswith("}}", m):
                break
            else:
                m += 1
        if m >= n:
            raise TemplateError("unclosed action")
        body = src[k:m]
        rtrim = False
        if re.search(r"[ \t\r\n]-$", body):
            rtrim = True
            body = body[:-1]
        if ltrim and toks and toks[-1][0] == "text":
            toks[-1][1] = toks[-1][1].rstrip(" \t\r\n")
        toks.append(["action", body.strip()])
        if rtrim:
            # trim the leading whitespace of the next text
            nxt = m + 2
            while nxt < n and src[nxt] in " \t\r\n":
                nxt += 1
            i = nxt
        else:
            i = m + 2
    return [(a, b) for a, b in toks if not (a == "text" and b == "")]


def _tokens(s: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    pos = 0
    s = s.strip()
    while pos < len(s):
        m = _TOKEN.match(s, pos)
        if not m or m.end() == pos:
            raise TemplateError(f"cannot parse {s[pos:]!r}")
        pos = m.end()
        kind = m.lastgroup
        out.append((kind, m.group(kind)))  # type: ignore[arg-type]
    return out


def _unquote(tok: str) -> str:
    if tok.startswith("`"):
        return tok[1:-1]
    body = tok[1:-1]
    return re.sub(r"\\(.)", lambda m: {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\"}.get(m.group(1), m.group(1)), body)


def _parse_pipeline(toks: list[tuple[str, str]]) -> Pipe:
    pos = 0
    decl = None
    assign = False
    # variable declaration / assignment: $a := ..., $a, $b := ..., $a = ...
    j = 0
    names = []
    while j < len(toks) and toks[j][0] == "var" and re.fullmatch(r"\$[A-Za-z_]\w*", toks[j][1]):
        names.append(toks[j][1])
        j += 1
        if j < len(toks) and toks[j] == ("op", ","):
            j += 1
            continue
        break
    if names and j < len(toks) and toks[j][0] == "op" and toks[j][1] in (":=", "="):
        decl = names
        assign = toks[j][1] == "="
        pos = j + 1

    def parse_cmd(p: int) -> tuple[list, int]:
        terms: list = []
        while p < len(toks):
            kind, val = toks[p]
            if kind == "op" and val in ("|", ")"):
                break
            if kind == "op" and val == "(":
                depth = 1
                q = p + 1
                while q < len(toks) and depth:
                    if toks[q] == ("op", "("):
                        depth += 1
                    elif toks[q] == ("op", ")"):
                        depth -= 1
                    q += 1
                if depth:
                    raise TemplateError("unbalanced parentheses")
                terms.append(("sub", _parse_pipeline(toks[p + 1 : q - 1])))
                p = q
                continue
            if kind in ("str", "raw"):
                terms.append(("lit", _unquote(val)))
            elif kind == "num":
                terms.append(("lit", float(val) if "." in val else int(val)))
            elif kind in ("var", "field"):
                terms.append(("path", val))
            elif kind == "ident":
                terms.append(("lit", True) if val == "true" else ("lit", False) if val == "false" else ("lit", None) if val == "nil" else ("ident", val))
            else:
                raise TemplateError(f"unexpected {val!r}")
            p += 1
        return terms, p

    cmds = []
    p = pos
    while True:
        terms, p = parse_cmd(p)
        if not terms:
            raise TemplateError("empty command in pipeline")
        cmds.append(terms)
        if p < len(toks) and toks[p] == ("op", "|"):
            p += 1
            continue
        break
    if p != len(toks):
        raise TemplateError("trailing tokens in pipeline")
    return Pipe(decl, assign, cmds)


class Parser:
    def __init__(self, renderer: "Renderer"):
        self.r = renderer

    def parse(self, src: str) -> list[Node]:
        self.toks = _scan(src)
        self.i = 0
        nodes, end = self._list()
        if end is not None:
            raise TemplateError(f"unexpected {{{{ {end} }}}}")
        return nodes

    def _list(self) -> tuple[list[Node], str | None]:
        nodes: list[Node] = []
        while self.i < len(self.toks):
            kind, val = self.toks[self.i]
            self.i += 1
            if kind == "text":
                nodes.append(Text(val))
                continue
            if val.startswith("/*") and val.endswith("*/"):
                continue
            word = val.split(None, 1)[0] if val else ""
            rest = val[len(word) :].strip()
            if word in ("end", "else"):
                return nodes, val
            if word == "if" or word == "with":
                nodes.append(self._cond(word, rest))
            elif word == "range":
                nodes.append(self._range(rest))
            elif word == "define":
                name = _unquote(rest)
                body, end = self._list()
                if end != "end":
                    raise TemplateError(f"define {name!r} is not closed")
                self.r.templates[name] = body
            elif word == "template":
                m = re.match(r'("(?:[^"\\]|\\.)*")\s*(.*)', rest)
                if not m:
                    raise TemplateError("template needs a name")
                nodes.append(TemplateCall(_unquote(m.group(1)), _parse_pipeline(_tokens(m.group(2) or "."))))
            elif word in ("break", "continue", "block"):
                raise TemplateError(f"{word} is not supported by the preflight renderer; the chart does not use it")
            else:
                nodes.append(Action(_parse_pipeline(_tokens(val))))
        return nodes, None

    def _cond(self, word: str, rest: str) -> Node:
        pipe = _parse_pipeline(_tokens(rest))
        body, end = self._list()
        els: list[Node] = []
        if end is None:
            raise TemplateError(f"{word} is not closed")
        if end.startswith("else"):
            tail = end[4:].strip()
            if tail.startswith("if "):
                els = [self._cond("if", tail[3:].strip())]
            elif tail.startswith("with "):
                els = [self._cond("with", tail[5:].strip())]
            elif tail == "":
                els, end2 = self._list()
                if end2 != "end":
                    raise TemplateError(f"{word} is not closed")
            else:
                raise TemplateError(f"bad else: {end!r}")
        return (With if word == "with" else If)(pipe, body, els)

    def _range(self, rest: str) -> Node:
        toks = _tokens(rest)
        vars_ = None
        j = 0
        names = []
        while j < len(toks) and toks[j][0] == "var":
            names.append(toks[j][1])
            j += 1
            if j < len(toks) and toks[j] == ("op", ","):
                j += 1
                continue
            break
        if names and j < len(toks) and toks[j] == ("op", ":="):
            vars_ = names
            toks = toks[j + 1 :]
        pipe = _parse_pipeline(toks)
        body, end = self._list()
        els: list[Node] = []
        if end is None:
            raise TemplateError("range is not closed")
        if end.startswith("else"):
            els, end2 = self._list()
            if end2 != "end":
                raise TemplateError("range is not closed")
        return Range(vars_, pipe, body, els)


# ----------------------------------------------------------------------------------------------------------------
# execution


class Scope:
    def __init__(self):
        self.frames: list[dict[str, Any]] = [{}]

    def push(self):
        self.frames.append({})

    def pop(self):
        self.frames.pop()

    def declare(self, name: str, v: Any):
        self.frames[-1][name] = v

    def assign(self, name: str, v: Any):
        for f in reversed(self.frames):
            if name in f:
                f[name] = v
                return
        raise TemplateError(f"undefined variable {name}")

    def get(self, name: str):
        for f in reversed(self.frames):
            if name in f:
                return f[name]
        raise TemplateError(f"undefined variable {name}")


def _num(a: Any) -> float:
    if isinstance(a, bool) or not isinstance(a, (int, float)):
        raise TemplateError(f"expected a number, got {a!r}")
    return a


def _cmp(a: Any, b: Any) -> int:
    if isinstance(a, str) and isinstance(b, str):
        return (a > b) - (a < b)
    a, b = _num(a), _num(b)
    return (a > b) - (a < b)


def _eq(a: Any, b: Any) -> bool:
    if isinstance(a, bool) != isinstance(b, bool):
        raise TemplateError(f"eq: incompatible types {a!r}, {b!r}")
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, str) != isinstance(b, str):
        raise TemplateError(f"eq: incompatible types {a!r}, {b!r}")
    return a == b


class Renderer:
    def __init__(self):
        self.templates: dict[str, list[Node]] = {}
        self.funcs: dict[str, Callable[..., Any]] = self._funcs()

    # -- public ------------------------------------------------------------------------------------------------
    def add(self, name: str, src: str) -> list[Node]:
        try:
            return Parser(self).parse(src)
        except TemplateError as e:
            raise TemplateError(f"{name}: {e}") from None

    def render_text(self, src: str, root: dict) -> str:
        nodes = self.add("<text>", src)
        return self.exec(nodes, root, root)

    def exec(self, nodes: list[Node], dot: Any, root: Any) -> str:
        out: list[str] = []
        self._run(nodes, dot, root, Scope(), out)
        return "".join(out)

    # -- nodes -------------------------------------------------------------------------------------------------
    def _run(self, nodes: list[Node], dot: Any, root: Any, sc: Scope, out: list[str]) -> None:
        for n in nodes:
            if isinstance(n, Text):
                out.append(n.s)
            elif isinstance(n, Action):
                v = self._pipe(n.pipe, dot, root, sc)
                if n.pipe.decl is None:
                    out.append(fmt(v))
            elif isinstance(n, With):
                sc.push()
                v = self._pipe(n.pipe, dot, root, sc)
                if truthy(v):
                    self._run(n.body, v, root, sc, out)
                else:
                    self._run(n.els, dot, root, sc, out)
                sc.pop()
            elif isinstance(n, If):
                sc.push()
                v = self._pipe(n.pipe, dot, root, sc)
                self._run(n.body if truthy(v) else n.els, dot, root, sc, out)
                sc.pop()
            elif isinstance(n, Range):
                coll = self._pipe(n.pipe, dot, root, sc)
                items: list[tuple[Any, Any]]
                if isinstance(coll, dict):
                    items = [(k, coll[k]) for k in sorted(coll)]
                elif isinstance(coll, list):
                    items = list(enumerate(coll))
                elif coll is None:
                    items = []
                else:
                    raise TemplateError(f"range over {type(coll).__name__}")
                if not items:
                    self._run(n.els, dot, root, sc, out)
                for k, v in items:
                    sc.push()
                    if n.vars:
                        if len(n.vars) == 1:
                            sc.declare(n.vars[0], v)
                        else:
                            sc.declare(n.vars[0], k)
                            sc.declare(n.vars[1], v)
                    self._run(n.body, v, root, sc, out)
                    sc.pop()
            elif isinstance(n, TemplateCall):
                ctx = self._pipe(n.pipe, dot, root, sc)
                out.append(self._include(n.name, ctx))
            else:  # pragma: no cover
                raise TemplateError(f"unknown node {n!r}")

    def _include(self, name: str, ctx: Any) -> str:
        body = self.templates.get(name)
        if body is None:
            raise TemplateError(f"template {name!r} is not defined")
        out: list[str] = []
        self._run(body, ctx, ctx, Scope(), out)
        return "".join(out)

    # -- expressions -------------------------------------------------------------------------------------------
    def _pipe(self, p: Pipe, dot: Any, root: Any, sc: Scope) -> Any:
        val: Any = _NOVAL
        for cmd in p.cmds:
            val = self._cmd(cmd, dot, root, sc, val)
        if p.decl:
            if p.assign:
                sc.assign(p.decl[0], val)
            else:
                sc.declare(p.decl[0], val)
        return val

    def _term(self, t: tuple, dot: Any, root: Any, sc: Scope) -> Any:
        kind, val = t
        if kind == "lit":
            return val
        if kind == "sub":
            return self._pipe(val, dot, root, sc)
        if kind == "path":
            return self._path(val, dot, root, sc)
        if kind == "ident":
            return self._call(val, [], dot, root, sc)
        raise TemplateError(f"bad term {t!r}")

    def _path(self, path: str, dot: Any, root: Any, sc: Scope) -> Any:
        if path.startswith("$"):
            m = re.match(r"(\$[A-Za-z_]\w*|\$)(.*)", path)
            base = root if m.group(1) == "$" else sc.get(m.group(1))  # type: ignore[union-attr]
            rest = m.group(2)  # type: ignore[union-attr]
        else:
            base, rest = dot, path
        if rest in ("", "."):
            return base
        cur = base
        for key in rest.strip(".").split("."):
            if cur is None:
                raise TemplateError(f"nil pointer evaluating .{key} (in {path})")
            if isinstance(cur, dict):
                cur = cur.get(key)
            else:
                raise TemplateError(f"can't evaluate field {key} in {type(cur).__name__} (in {path})")
        return cur

    def _cmd(self, terms: list, dot: Any, root: Any, sc: Scope, piped: Any) -> Any:
        head = terms[0]
        if head[0] == "ident":
            args = [self._term(t, dot, root, sc) for t in terms[1:]]
            if piped is not _NOVAL:
                args.append(piped)
            return self._call(head[1], args, dot, root, sc)
        if len(terms) > 1 or piped is not _NOVAL:
            raise TemplateError(f"can't give arguments to non-function {head!r}")
        return self._term(head, dot, root, sc)

    def _call(self, name: str, args: list, dot: Any, root: Any, sc: Scope) -> Any:
        if name == "and":
            return self._shortcircuit(args, False)
        if name == "or":
            return self._shortcircuit(args, True)
        f = self.funcs.get(name)
        if f is None:
            raise TemplateError(f"function {name!r} not defined")
        try:
            return f(*args)
        except TemplateError:
            raise
        except TypeError as e:
            raise TemplateError(f"{name}: {e}") from None

    @staticmethod
    def _shortcircuit(args: list, stop_on: bool) -> Any:
        v = None
        for a in args:
            v = a
            if truthy(a) == stop_on:
                return a
        return v

    # -- functions ---------------------------------------------------------------------------------------------
    def _funcs(self) -> dict[str, Callable[..., Any]]:
        def required(msg, v=None):
            if v is None or v == "":
                raise TemplateError(msg)
            return v

        def fail(msg):
            raise TemplateError(msg)

        def default(d, v=None):
            return v if truthy(v) else d

        def indent(n, s):
            pad = " " * int(n)
            return "\n".join(pad + line for line in str(s).split("\n"))

        def trunc(n, s):
            n = int(n)
            return str(s)[:n] if n >= 0 else str(s)[n:]

        def quote(*a):
            return " ".join(go_quote(fmt(x)) for x in a if x is not None)

        def squote(*a):
            return " ".join("'" + fmt(x) + "'" for x in a if x is not None)

        def dict_(*kv):
            if len(kv) % 2:
                raise TemplateError("dict needs an even number of arguments")
            return {str(kv[i]): kv[i + 1] for i in range(0, len(kv), 2)}

        def set_(d, k, v):
            d[k] = v
            return d

        def merge(dst, *srcs):
            for s in srcs:
                for k, v in s.items():
                    if k not in dst:
                        dst[k] = v
            return dst

        def merge_over(dst, *srcs):
            for s in srcs:
                dst.update(s)
            return dst

        def kind_is(kind, v):
            return {
                "string": isinstance(v, str),
                "map": isinstance(v, dict),
                "slice": isinstance(v, list),
                "bool": isinstance(v, bool),
                "int": isinstance(v, int) and not isinstance(v, bool),
                "float64": isinstance(v, (int, float)) and not isinstance(v, bool),
                "invalid": v is None,
            }[kind]

        def index(c, *keys):
            for k in keys:
                if isinstance(c, dict):
                    c = c.get(k)
                elif isinstance(c, list):
                    c = c[int(k)]
                else:
                    raise TemplateError("index of non-indexable value")
            return c

        def length(v):
            return len(v)

        def to_int(v):
            return int(float(v)) if isinstance(v, str) else int(v)

        return {
            "include": lambda name, ctx=None: self._include(name, ctx),
            "toYaml": to_yaml,
            "toJson": lambda v: json.dumps(v, sort_keys=True, separators=(",", ":")),
            "indent": indent,
            "nindent": lambda n, s: "\n" + indent(n, s),
            "quote": quote,
            "squote": squote,
            "default": default,
            "required": required,
            "fail": fail,
            "printf": go_printf,
            "print": lambda *a: "".join(fmt(x) for x in a),
            "eq": lambda a, *rest: any(_eq(a, b) for b in rest),
            "ne": lambda a, b: not _eq(a, b),
            "lt": lambda a, b: _cmp(a, b) < 0,
            "le": lambda a, b: _cmp(a, b) <= 0,
            "gt": lambda a, b: _cmp(a, b) > 0,
            "ge": lambda a, b: _cmp(a, b) >= 0,
            "not": lambda v: not truthy(v),
            "len": length,
            "empty": lambda v=None: not truthy(v),
            "hasKey": lambda d, k: isinstance(d, dict) and k in d,
            "list": lambda *a: list(a),
            "dict": dict_,
            "set": set_,
            "merge": merge,
            "mergeOverwrite": merge_over,
            "index": index,
            "keys": lambda d: sorted(d),
            "sortAlpha": lambda l: sorted(str(x) for x in l),
            "first": lambda l: l[0] if l else None,
            "last": lambda l: l[-1] if l else None,
            "join": lambda sep, l: str(sep).join(fmt(x) for x in l),
            "splitList": lambda sep, s: str(s).split(sep),
            "upper": lambda s: str(s).upper(),
            "lower": lambda s: str(s).lower(),
            "trim": lambda s: str(s).strip(),
            "trunc": trunc,
            "trimSuffix": lambda suf, s: str(s)[: -len(suf)] if suf and str(s).endswith(suf) else str(s),
            "trimPrefix": lambda pre, s: str(s)[len(pre) :] if str(s).startswith(pre) else str(s),
            "replace": lambda old, new, s: str(s).replace(old, new),
            "contains": lambda sub, s: sub in str(s),
            "hasPrefix": lambda pre, s: str(s).startswith(pre),
            "hasSuffix": lambda suf, s: str(s).endswith(suf),
            "regexMatch": lambda pat, s: re.search(pat, str(s)) is not None,
            "b64enc": lambda s: base64.b64encode(str(s).encode()).decode(),
            "sha256sum": lambda s: hashlib.sha256(str(s).encode()).hexdigest(),
            "toString": fmt,
            "int": to_int,
            "add": lambda *a: sum(to_int(x) for x in a),
            "sub": lambda a, b: to_int(a) - to_int(b),
            "mul": lambda *a: __import__("math").prod(to_int(x) for x in a),
            "until": lambda n: list(range(to_int(n))),
            "ternary": lambda t, f, c: t if truthy(c) else f,
            "kindIs": kind_is,
            "lookup": lambda *a: {},
            "tpl": lambda s, ctx: self.render_text(s, ctx),
            "deepCopy": lambda v: json.loads(json.dumps(v)),
        }


class _NoVal:
    pass


_NOVAL = _NoVal()


# ----------------------------------------------------------------------------------------------------------------
# charts


def deep_merge(base: Any, over: Any) -> Any:
    if isinstance(base, dict) and isinstance(over, dict):
        out = dict(base)
        for k, v in over.items():
            out[k] = deep_merge(base[k], v) if k in base else v
        return {k: v for k, v in out.items() if v is not None}  # Helm: null deletes a key
    return over


def parse_set(spec: str) -> dict:
    key, _, raw = spec.partition("=")
    val: Any
    if raw in ("true", "false"):
        val = raw == "true"
    elif raw == "null":
        val = None
    elif re.fullmatch(r"-?\d+", raw):
        val = int(raw)
    else:
        val = raw
    out: dict = {}
    cur = out
    parts = key.split(".")
    for p in parts[:-1]:
        cur = cur.setdefault(p, {})
    cur[parts[-1]] = val
    return out


def render_chart(chart_dir: str, values_files: list[str] | None = None, sets: list[str] | None = None, release: str = "omnisync", namespace: str = "omnisync") -> dict[str, str]:
    """Returns {template file name: rendered text}; helper files (names starting with _) are not rendered on their own."""
    chart = yaml.safe_load(open(os.path.join(chart_dir, "Chart.yaml")))
    values = yaml.safe_load(open(os.path.join(chart_dir, "values.yaml"))) or {}
    for f in values_files or []:
        values = deep_merge(values, yaml.safe_load(open(f)) or {})
    for s in sets or []:
        values = deep_merge(values, parse_set(s))

    schema_path = os.path.join(chart_dir, "values.schema.json")
    if os.path.exists(schema_path):
        import jsonschema

        errs = sorted(jsonschema.Draft7Validator(json.load(open(schema_path))).iter_errors(values), key=lambda e: list(e.path))
        if errs:
            raise TemplateError("values don't meet the specifications of the schema(s):\n" + "\n".join(f"- {'.'.join(map(str, e.path)) or '(root)'}: {e.message}" for e in errs))

    r = Renderer()
    tdir = os.path.join(chart_dir, "templates")
    files = sorted(os.listdir(tdir))
    parsed: dict[str, list[Node]] = {}
    for name in files:
        path = os.path.join(tdir, name)
        if not os.path.isfile(path):
            continue
        parsed[name] = r.add(name, open(path).read())
    root = {
        "Values": values,
        "Chart": {"Name": chart["name"], "Version": chart["version"], "AppVersion": chart.get("appVersion", "")},
        "Release": {"Name": release, "Namespace": namespace, "Service": "Helm", "IsInstall": True, "IsUpgrade": False, "Revision": 1},
        "Capabilities": {"KubeVersion": {"Version": "v1.31.0", "Major": "1", "Minor": "31"}},
    }
    out: dict[str, str] = {}
    for name, nodes in parsed.items():
        if name.startswith("_"):
            continue
        try:
            out[name] = r.exec(nodes, root, root)
        except TemplateError as e:
            raise TemplateError(f"{name}: {e}") from None
    return out


def manifests(rendered: dict[str, str]) -> list[dict]:
    docs: list[dict] = []
    for name, text in rendered.items():
        if name == "NOTES.txt":
            continue
        for d in yaml.safe_load_all(text):
            if d:
                d.setdefault("metadata", {})
                d["_source"] = name
                docs.append(d)
    return docs


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("chart")
    ap.add_argument("-f", "--values", action="append", default=[])
    ap.add_argument("--set", action="append", default=[])
    ap.add_argument("--release", default="omnisync")
    ap.add_argument("--namespace", default="omnisync")
    ap.add_argument("--notes", action="store_true", help="print NOTES.txt instead of the manifests")
    a = ap.parse_args(argv)
    try:
        rendered = render_chart(a.chart, a.values, a.set, a.release, a.namespace)
    except TemplateError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    if a.notes:
        print(rendered.get("NOTES.txt", ""))
        return 0
    for d in manifests(rendered):
        src = d.pop("_source")
        print(f"---\n# Source: {a.chart}/templates/{src}")
        print(yaml.safe_dump(d, default_flow_style=False, sort_keys=True, width=100000).rstrip("\n"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
