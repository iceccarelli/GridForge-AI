// ESLint 9 flat config. `next lint` is removed in Next.js 16, so linting runs through the ESLint CLI (`npm run lint`).
// eslint-config-next 15 is a legacy shareable config, loaded through FlatCompat. After a move to Next 16 this becomes
// `import coreWebVitals from "eslint-config-next/core-web-vitals"`; that move also surfaces 23 React Compiler-era findings in existing code.
import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: [".next/**", "node_modules/**", "public/**", "coverage/**", "observatory-broadcast/**", "scripts/**", "tests/**"] },
  ...compat.extends("next/core-web-vitals"),
  { rules: { "react/no-unescaped-entities": "off" } },
];

export default config;
