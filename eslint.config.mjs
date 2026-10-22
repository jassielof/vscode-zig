// @ts-check

import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default defineConfig(
    {
        files: ["**/*.ts"],
        extends: [
            js.configs.recommended,
            tseslint.configs.strictTypeChecked,
            tseslint.configs.stylisticTypeChecked,
            prettierConfig,
        ],
        rules: {
            "@typescript-eslint/naming-convention": "error",
            "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
            eqeqeq: "error",
            "@typescript-eslint/only-throw-error": "error",
            "no-shadow": "off",
            "@typescript-eslint/no-shadow": "error",
            "no-duplicate-imports": "error",
            "no-empty": ["error", { allowEmptyCatch: true }],
            "sort-imports": ["error", { allowSeparatedGroups: true }],
        },
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    globalIgnores(["**/*.js", "**/*.mjs"]),
);
