import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Vitest 5's default transformer (oxc) cannot parse TypeScript parameter decorators, which NestJS
// controllers use (@Body, @Param, ...). SWC compiles them; production builds use tsc.
export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: false },
        target: "es2022",
      },
    }),
  ],
  test: { testTimeout: 15_000 },
});
