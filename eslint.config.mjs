import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...nextVitals,
  {
    rules: {
      "react/display-name": "off",
    },
  },
  globalIgnores([
    ".next/**",
    ".next-*/**",
    "node_modules/**",
    "tsconfig.tsbuildinfo",
  ]),
]);
