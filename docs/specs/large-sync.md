# Spec: opening a large document (ticket L1, Phase 1, week 11 preparation)

**Problem.** `decodeFrame` refuses a payload over 1 MiB by default (`DEFAULT_MAX_PAYLOAD_BYTES`). That is the right cap for a frame a *client sends* (an edit), and the gateway enforces it for them. It is the wrong cap for the frame the gateway sends to a client that is catching up: SYNC_2 carries the whole difference between the client's state and the document's, so for a document whose state is larger than 1 MiB it is larger than 1 MiB. `GatewayClient` (`apps/gateway/src/client.ts`) and the SDK's `SyncDocument` (`packages/sdk/src/document.ts`) decode every inbound frame with the default, catch the error and return, so the SYNC_2 vanishes. The client waits, times out, reconnects and repeats. Found by the week-10 load run (`docs/specs/load.md`, L1): a 10 MB document cannot be opened by any stock client, although the gateway serves it in about 100 ms.

## Behaviour

1. **A bounded, larger cap for inbound frames.** `packages/protocol/src/limits.ts` exports `MAX_INBOUND_PAYLOAD_BYTES = 64 MiB`, the same figure the gateway already uses to read its own stored frames (`MAX_STORED_PAYLOAD` in `room.ts`) and the verifier uses for exports. `GatewayClient` and `SyncDocument` decode frames received from the gateway with it. `frame.ts` is not changed: `decodeFrame` already takes `maxPayloadBytes`, and the default stays 1 MiB for everything that does not ask.
2. **Configurable.** Both clients take `maxInboundBytes` (integer from 1 to the constant, default the constant; anything else throws `RangeError` when the client is created, via `resolveInboundCap`). A smaller value makes a constrained device refuse early; the constant is also the maximum, so a configuration cannot reopen the memory exposure.
3. **Not silent.** A frame that fails to decode, or is over the cap, is still dropped (hostile input never throws past a boundary), but it is now counted and remembered: `GatewayClient.decodeErrors` / `lastDecodeError` and the same two names on `SyncDocument`, plus an `onDecodeError(description)` callback option on both (an exception from the callback is swallowed). The description is the `FrameError` code and sizes (`describeDecodeError`), never bytes. When `GatewayClient.connect` fails because the connection closed before the first sync, its message now names the dropped frame (`connection closed before sync: dropped frame (1 dropped, last: too_large: ...)`) when the gateway sent no reason of its own. This turns "reconnects forever for no visible reason" into a number and a message a test, a log line or an operator can read.
4. **Outbound is unchanged.** What a client sends is still capped at 1 MiB by the gateway (`too_large`). A single local edit larger than that (a very large paste) is refused by the gateway, as before; chunking edits is a separate matter and not part of L1.
5. **Offline outbox.** `SyncDocument` replays its own queued frames with the default cap (it wrote them, and they were under 1 MiB when sent). Unchanged.

## Failure modes and limits

- **Over the cap.** A document whose state diff is over `maxInboundBytes` still cannot be opened. The client now says so (`decodeErrors` increases and `lastDecodeError` names `too_large`), but the gateway still sends the frame. A gateway-side refusal (an ERROR frame naming the limit instead of sending 64 MiB the client will drop) lives in `gateway.ts`, a protected path, and is ticket L7.
- **Memory.** The cap allows a 64 MiB frame to be buffered by a browser before it is decoded, and the engine then holds the document. This is the cost of opening a 64 MiB document; it is not a new attack surface beyond the gateway being trusted by the client (TLS), but the cap exists precisely so that it is bounded. The 10 MB case measured in `docs/specs/load.md` is the evidence for the 10 MB size only; memory in a real browser was not measured (L8).
- **Streaming.** SYNC_2 is still one frame. Chunking it would be a wire-format change (protected, protocol version bump) and is only worth it if 64 MiB proves too small or too heavy.

## Tests (written first, failing before the change)

- `packages/protocol/test/limits.test.ts`: the constant is 64 MiB, is above the default, and `decodeFrame` accepts a payload at the cap and refuses one byte over when given it.
- `apps/gateway/test/large-sync.test.ts`: a gateway with a 3 MiB document; a fresh `GatewayClient` opens it and the text matches; a client with `maxInboundBytes` below the size does not sync, `decodeErrors` is at least 1 and `lastDecodeError` mentions `too_large`; garbage bytes from a server increment `decodeErrors` without throwing.
- `packages/sdk/test/large-sync.test.ts`: the same through `SyncDocument` with the SDK test harness.
- `bench/test/scenarios.test.ts`: the test that documented L1 now expects the stock client to load a 2 MiB document, and the load harness's cold-load scenario reports the stock client as loading the 10 MB document.
- Mutation checks on the new code (`mutateL1`: the cap constant, the option default and its validation bounds, the use of the cap at both decode sites, the counters, the callback and its guard, the error text): 24 mutants, 3 survived the first run and were closed with tests (the off-by-one at the maximum, a gateway-given reason being hidden by the dropped-frame note, an unguarded observer in the SDK); none survive.

## Dependencies

None.

## Protected paths

None changed. `packages/protocol/src/limits.ts` is new and not in the protected list; `frame.ts` and `signing.ts` are untouched. The index re-export (`packages/protocol/src/index.ts`) gains one line.
