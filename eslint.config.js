import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

// 扁平 ESLint 配置（ESLint 9+）。
// 项目已开启 tsconfig strict + noUnusedLocals + noUnusedParameters（无任何 @ts-ignore）。
// 此处仅做"防御性收口 + 基建补齐"：规则以 warn 为主，默认不阻断构建，
// 用于本地排查与 CI 渐进式收敛（见 CODE_REVIEW_REPORT.md 的 P0 阶段）。
//
// 注意：typescript-eslint 的 recommended 中部分规则（如 @typescript-eslint/no-unused-vars）
// 定义在"无 files 的全局配置"上。为使本项目调整稳胜，规则调整块也放在全局（无 files）
// 并置于数组末尾，按数组顺序覆盖。
export default tseslint.config(
  {
    ignores: [
      'dist',
      'node_modules',
      'public/lite',
      'coverage',
      'android',
      'ios',
      'beatmaps',
      '**/build/**',
      '**/dist/**',
      '*.config.ts',
      '*.config.mjs',
      'update-beatmaps.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 浏览器/Node 上下文的 .js 脚本（如 public 内 PWA 脚本）：补全局，避免
    // no-undef 误报 document/window/process/console 等。
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    // 全局规则调整块（无 files，置于末尾，按数组顺序覆盖 recommended 的全局规则）。
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser },
    },
    rules: {
      // 以下基础规则由 TS（strict + noUnusedLocals）覆盖，关闭以避免与浏览器全局
      // 环境（document/window/FileReader）冗余冲突；类型正确性以 tsc 为准。
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      // React Hooks 规则（手写 RAF/tick 与大量 prop→ref 镜像需要规范化）。
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // 组件文件常同时导出常量/类型，仅作 warn 不阻断。
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // 类型断言收敛：项目中 ~19 处 any 多为 CSS 变量/设置迁移，逐步替换。
      '@typescript-eslint/no-explicit-any': 'warn',
      // 裸 Three.js 场景下常有非空断言，warn 提示而非阻断。
      '@typescript-eslint/no-non-null-assertion': 'warn',
      // 以下为风格/健壮性建议，降级为 warn 以渐进收敛（属 P2 整改项）：
      '@typescript-eslint/no-this-alias': 'warn',
      'no-empty': 'warn',
      'no-prototype-builtins': 'warn',
    },
  },
);
