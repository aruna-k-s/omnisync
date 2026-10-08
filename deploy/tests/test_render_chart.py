"""Semantics of the Go-template subset renderer (deploy/tools/render_chart.py). Helm is the authority; each case here is
a behaviour Go's text/template and Helm's functions are known to have, written down so the preflight cannot drift."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
from render_chart import TemplateError, Renderer  # noqa: E402


def render(src, values=None, helpers="", **extra):
    r = Renderer()
    if helpers:
        r.add("_helpers.tpl", helpers)
    root = {"Values": values or {}, "Release": {"Name": "rel", "Namespace": "ns"}, "Chart": {"Name": "omnisync", "Version": "1.2.3", "AppVersion": "0.9"}}
    root.update(extra)
    return r.render_text(src, root)


class Text(unittest.TestCase):
    def test_plain_text_and_values(self):
        self.assertEqual(render("a {{ .Values.x }} b", {"x": "X"}), "a X b")

    def test_missing_value_prints_nothing(self):
        self.assertEqual(render("[{{ .Values.nope }}][{{ .Values.a.b }}]", {"a": {}}), "[][]")

    def test_numbers_and_bools_print_like_go(self):
        self.assertEqual(render("{{ .Values.n }} {{ .Values.t }} {{ .Values.f }} {{ .Values.z }}", {"n": 5, "t": True, "f": False, "z": 0}), "5 true false 0")

    def test_comment_is_dropped(self):
        self.assertEqual(render("a{{/* hello */}}b"), "ab")


class Trim(unittest.TestCase):
    def test_left_trim_removes_all_preceding_whitespace(self):
        self.assertEqual(render("a  \n\t {{- .Values.x }}", {"x": "X"}), "aX")

    def test_right_trim_removes_all_following_whitespace(self):
        self.assertEqual(render("{{ .Values.x -}}  \n\t b", {"x": "X"}), "Xb")

    def test_no_trim_keeps_whitespace(self):
        self.assertEqual(render("a \n{{ .Values.x }}\n b", {"x": "X"}), "a \nX\n b")

    def test_trim_needs_a_space_to_be_a_marker(self):
        # "{{-3}}" is the number -3, not a trim marker
        self.assertEqual(render("a {{-3}} b"), "a -3 b")

    def test_trim_around_control_lines(self):
        src = "x:\n{{- if .Values.on }}\n  y: 1\n{{- end }}\nz: 2\n"
        self.assertEqual(render(src, {"on": True}), "x:\n  y: 1\nz: 2\n")
        self.assertEqual(render(src, {"on": False}), "x:\nz: 2\n")


class Control(unittest.TestCase):
    def test_if_else_if_else(self):
        src = "{{ if eq .Values.k 1 }}one{{ else if eq .Values.k 2 }}two{{ else }}many{{ end }}"
        self.assertEqual([render(src, {"k": k}) for k in (1, 2, 3)], ["one", "two", "many"])

    def test_truthiness(self):
        src = "{{ if .Values.v }}T{{ else }}F{{ end }}"
        for v, want in [(None, "F"), (0, "F"), ("", "F"), ([], "F"), ({}, "F"), (False, "F"), ("0", "T"), (1, "T"), ([0], "T"), ({"a": 1}, "T"), (True, "T")]:
            self.assertEqual(render(src, {"v": v}), want, repr(v))

    def test_and_or_not_return_operands_and_short_circuit(self):
        self.assertEqual(render('{{ or .Values.a .Values.b "z" }}', {"a": "", "b": "B"}), "B")
        self.assertEqual(render('{{ or .Values.a .Values.b "z" }}', {"a": "", "b": ""}), "z")
        self.assertEqual(render('{{ and .Values.a .Values.b }}', {"a": "A", "b": "B"}), "B")
        self.assertEqual(render('{{ and .Values.a .Values.b }}', {"a": "", "b": "B"}), "")
        self.assertEqual(render("{{ not .Values.a }}", {"a": ""}), "true")

    def test_eq_compares_with_any_of_the_rest_and_ne_lt_gt(self):
        self.assertEqual(render('{{ eq "b" "a" "b" }}|{{ ne 1 2 }}|{{ lt 1 2 }}|{{ gt 1 2 }}|{{ le 2 2 }}|{{ ge 1 2 }}'), "true|true|true|false|true|false")

    def test_range_over_list_and_map_with_variables(self):
        self.assertEqual(render("{{ range .Values.l }}[{{ . }}]{{ end }}", {"l": [1, 2]}), "[1][2]")
        self.assertEqual(render("{{ range $i, $v := .Values.l }}{{ $i }}={{ $v }};{{ end }}", {"l": ["a", "b"]}), "0=a;1=b;")
        # maps iterate in sorted key order
        self.assertEqual(render("{{ range $k, $v := .Values.m }}{{ $k }}={{ $v }};{{ end }}", {"m": {"b": 2, "a": 1}}), "a=1;b=2;")

    def test_range_else_runs_on_empty(self):
        self.assertEqual(render("{{ range .Values.l }}x{{ else }}none{{ end }}", {"l": []}), "none")

    def test_with_rebinds_dot_and_skips_when_empty(self):
        self.assertEqual(render("{{ with .Values.a }}<{{ .b }}>{{ end }}", {"a": {"b": "B"}}), "<B>")
        self.assertEqual(render("{{ with .Values.a }}<{{ .b }}>{{ else }}none{{ end }}", {"a": {}}), "none")

    def test_dollar_is_the_root_inside_range_and_with(self):
        self.assertEqual(render("{{ range .Values.l }}{{ $.Values.p }}{{ . }}{{ end }}", {"l": [1, 2], "p": "p"}), "p1p2")

    def test_variable_declaration_and_assignment_scoping(self):
        self.assertEqual(render("{{ $x := 1 }}{{ if true }}{{ $x = 2 }}{{ end }}{{ $x }}"), "2")
        self.assertEqual(render("{{ $x := 1 }}{{ if true }}{{ $x := 2 }}{{ end }}{{ $x }}"), "1")

    def test_unterminated_block_is_an_error(self):
        with self.assertRaises(TemplateError):
            render("{{ if true }}x")
        with self.assertRaises(TemplateError):
            render("x{{ end }}")


class Pipelines(unittest.TestCase):
    def test_pipe_passes_the_value_as_the_last_argument(self):
        self.assertEqual(render('{{ .Values.x | default "d" }}|{{ "" | default "d" }}', {"x": "X"}), "X|d")
        self.assertEqual(render('{{ .Values.x | printf "<%s>" }}', {"x": "X"}), "<X>")

    def test_parentheses(self):
        self.assertEqual(render('{{ (printf "%s-%s" "a" "b") | upper }}'), "A-B")
        self.assertEqual(render('{{ if and (eq 1 1) (not false) }}y{{ end }}'), "y")

    def test_strings_with_braces_and_escapes(self):
        self.assertEqual(render('{{ "a}}b\\"c" }}'), 'a}}b"c')

    def test_quote_and_squote(self):
        self.assertEqual(render('{{ "a\\"b" | quote }}|{{ "x" | squote }}|{{ 5 | quote }}'), '"a\\"b"|\'x\'|"5"')

    def test_indent_and_nindent(self):
        self.assertEqual(render('{{ "a\\nb" | indent 2 }}'), "  a\n  b")
        self.assertEqual(render('{{ "a\\nb" | nindent 2 }}'), "\n  a\n  b")

    def test_toyaml_sorts_keys_and_has_no_trailing_newline(self):
        self.assertEqual(render("{{ .Values.m | toYaml }}", {"m": {"b": [1, 2], "a": "x"}}), "a: x\nb:\n- 1\n- 2")
        self.assertEqual(render("{{ .Values.m | toYaml | nindent 2 }}", {"m": {"a": 1}}), "\n  a: 1")

    def test_trunc_trim_replace_contains(self):
        self.assertEqual(render('{{ "abcdef" | trunc 3 }}|{{ "abc-" | trimSuffix "-" }}|{{ "a.b" | replace "." "-" }}|{{ contains "b" "abc" }}|{{ hasPrefix "ab" "abc" }}'), "abc|abc|a-b|true|true")

    def test_required_fails_with_its_message_when_empty(self):
        self.assertEqual(render('{{ required "need x" .Values.x }}', {"x": "X"}), "X")
        with self.assertRaisesRegex(TemplateError, "need x"):
            render('{{ required "need x" .Values.x }}', {"x": ""})

    def test_fail_raises(self):
        with self.assertRaisesRegex(TemplateError, "boom"):
            render('{{ fail "boom" }}')

    def test_hasKey_dict_list_join_len_empty_ternary(self):
        self.assertEqual(render('{{ hasKey .Values.m "a" }}|{{ hasKey .Values.m "z" }}|{{ len .Values.l }}|{{ empty .Values.l }}|{{ list "a" "b" | join "," }}|{{ ternary "y" "n" true }}', {"m": {"a": 1}, "l": [1, 2]}), "true|false|2|false|a,b|y")
        self.assertEqual(render('{{ $d := dict "k" "v" }}{{ $d.k }}'), "v")

    def test_b64enc_sha256sum(self):
        self.assertEqual(render('{{ "abc" | b64enc }}|{{ "abc" | sha256sum }}'), "YWJj|ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")

    def test_unknown_function_is_an_error(self):
        with self.assertRaises(TemplateError):
            render("{{ nosuchfunc 1 }}")


class Named(unittest.TestCase):
    helpers = '{{- define "x.name" -}}{{ .Release.Name }}-{{ .Chart.Name }}{{- end -}}\n{{- define "x.pair" -}}{{ .a }}+{{ .b }}{{- end -}}'

    def test_define_and_include(self):
        self.assertEqual(render('{{ include "x.name" . }}', helpers=self.helpers), "rel-omnisync")

    def test_include_with_a_dict_context_and_pipe(self):
        self.assertEqual(render('{{ include "x.pair" (dict "a" 1 "b" 2) | upper }}', helpers=self.helpers), "1+2")

    def test_include_inside_nindent(self):
        self.assertEqual(render('k:{{ include "x.name" . | nindent 2 }}', helpers=self.helpers), "k:\n  rel-omnisync")

    def test_missing_template_is_an_error(self):
        with self.assertRaises(TemplateError):
            render('{{ include "nope" . }}')


if __name__ == "__main__":
    unittest.main()
