// The verifier core (and the crypto package it uses) call Buffer for base64 and byte comparison. Node has it; a
// browser does not. The `buffer` package is the standard, well-tested stand-in. Removing Buffer from the verifier
// itself is a protected-path change and is listed as a follow-up.
import { Buffer } from "buffer";

(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
