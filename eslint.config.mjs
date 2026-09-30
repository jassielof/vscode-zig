// @ts-check

import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
    tseslint.configs.stylisticTypeChecked,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.recommendedTypeChecked,
    tseslint.configs.eslintRecommended,
    prettierConfig,
    {
        rules: {
            "@typescript-eslint/naming-convention": "error",
            "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
            eqeqeq: "error",
            "no-throw-literal": "off",
            "@typescript-eslint/only-throw-error": "error",
            "no-shadow": "off",
            "@typescript-eslint/no-shadow": "error",
            "no-duplicate-imports": "error",
            "sort-imports": ["error", { allowSeparatedGroups: true }],
            "no-unused-vars": "off",
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                },
            ],
            "no-use-before-define": "off",
            "@typescript-eslint/no-use-before-define": ["error", { functions: false, classes: false, variables: true }],
            
        },
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        ignores: ["**/*.js", "**/*.mjs"],
    },
);
