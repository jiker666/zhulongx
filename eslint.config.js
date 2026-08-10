import tseslint from "typescript-eslint";

export default [
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: { parser: tseslint.parser, sourceType: "module", ecmaVersion: "latest" },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { args: "none", ignoreRestSiblings: true }],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
