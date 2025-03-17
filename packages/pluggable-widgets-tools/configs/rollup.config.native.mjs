/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { existsSync } from "fs";
import { join, relative } from "path";
import { getBabelInputPlugin, getBabelOutputPlugin } from "@rollup/plugin-babel";
import commonjs from "@rollup/plugin-commonjs";
import image from "@rollup/plugin-image";
import json from "@rollup/plugin-json";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import replace from "rollup-plugin-re";
import typescript from "@rollup/plugin-typescript";
import url from "@rollup/plugin-url";
import colors from "ansi-colors";
import loadConfigFile from "rollup/dist/loadConfigFile.js";
import clear from "rollup-plugin-clear";
import command from "rollup-plugin-command";
import terser from "@rollup/plugin-terser";
import shelljs from "shelljs";
import { widgetTyping } from "./rollup-plugin-widget-typing.mjs";
import { collectDependencies } from "./rollup-plugin-collect-dependencies.mjs";
import {
    editorConfigEntry,
    isTypescript,
    projectPath,
    sourcePath,
    widgetEntry,
    widgetName,
    widgetPackage,
    widgetVersion,
    onwarn
} from "./shared.mjs";
import { copyLicenseFile, createMpkFile, licenseCustomTemplate } from "./helpers/rollup-helper.mjs";

const { cp } = shelljs;
const { blue } = colors;

const outDir = join(sourcePath, "/dist/tmp/widgets/");
const outWidgetFile = join(widgetPackage.replace(/\./g, "/"), widgetName.toLowerCase(), `${widgetName}`);
const mpkDir = join(sourcePath, "dist", widgetVersion);
const mpkFile = join(mpkDir, process.env.MPKOUTPUT ? process.env.MPKOUTPUT : `${widgetPackage}.${widgetName}.mpk`);

const extensions = [".js", ".jsx", ".tsx", ".ts"];

const editorConfigExternal = [
    // "mendix" and internals under "mendix/"
    /^mendix($|\/)/,

    // "react"
    /^react$/,

    // "react/jsx-runtime"
    /^react\/jsx-runtime$/,

    // "react-dom"
    /^react-dom$/
];

const nativeExternal = [
    /^mendix($|\/)/,
    /^react-native($|\/)/,
    /^big.js$/,
    /^react($|\/)/,
    /^react-native-gesture-handler($|\/)/,
    /^react-native-reanimated($|\/)/,
    /^react-native-fast-image($|\/)/,
    /^react-native-svg($|\/)/,
    /^react-native-vector-icons($|\/)/,
    /^@?react-navigation($|\/)/,
    /^react-native-safe-area-context($|\/)/
];

export default async args => {
    const production = Boolean(args.configProduction);

    if (!production && projectPath) {
        console.info(blue(`Project Path: ${projectPath}`));
    }

    const result = [];

    ["ios", "android"].forEach((os, i) => {
        result.push({
            input: widgetEntry,
            output: {
                format: "es",
                file: join(outDir, `${outWidgetFile}.${os}.js`),
                sourcemap: false
            },
            external: nativeExternal,
            plugins: [
                replace({
                    patterns: [
                        {
                            test: /\b(?<!\.)Platform.OS\b(?!\s*=[^=])/g,
                            replace: `"${os}"`
                        }
                    ]
                }),
                ...(i === 0 ? getClientComponentPlugins() : []),
                json(),
                collectDependencies({
                    outputDir: outDir,
                    onlyNative: true,
                    widgetName,
                    ...(production && i === 0
                        ? {
                            licenseOptions: {
                                thirdParty: {
                                    output: [
                                        {
                                            file: join(outDir, "dependencies.txt")
                                        },
                                        {
                                            file: join(outDir, "dependencies.json"),
                                            template: licenseCustomTemplate
                                        }
                                    ]
                                }
                            }
                        }
                        : null)
                }),
                ...getCommonPlugins({
                    sourceMaps: false,
                    extensions: [`.${os}.js`, ".native.js", ".js", ".jsx", ".ts", ".tsx"],
                    transpile: false,
                    external: nativeExternal,
                    licenses: production && i === 0
                })
            ],
            onwarn: (warning, warn) => {
                if (warning.code === "UNUSED_EXTERNAL_IMPORT" && /('|")Platform('|")/.test(warning.message)) {
                    return;
                }
                onwarn(args)(warning, warn);
            }
        });
    });

    if (editorConfigEntry) {
        // Studio Pro의 JS 엔진은 es5만 지원하고 소스맵은 지원하지 않습니다
        result.push({
            input: editorConfigEntry,
            output: {
                format: "commonjs",
                file: join(outDir, `${widgetName}.editorConfig.js`),
                sourcemap: false
            },
            external: editorConfigExternal,
            treeshake: { moduleSideEffects: false },
            plugins: [
                url({ include: ["**/*.svg"], limit: 204800 }), // SVG file size limit of 200 kB
                ...getCommonPlugins({
                    sourceMaps: false,
                    extensions,
                    transpile: true,
                    babelConfig: { presets: [["@babel/preset-env", { targets: { ie: "11" } }]] },
                    external: editorConfigExternal
                })
            ],
            onwarn: onwarn(args)
        });
    }

    const customConfigPathJS = join(sourcePath, "rollup.config.js");
    const customConfigPathESM = join(sourcePath, "rollup.config.mjs");
    const existingConfigPath =
        existsSync(customConfigPathJS) ? customConfigPathJS
            : existsSync(customConfigPathESM) ? customConfigPathESM
                : null;
    if (existingConfigPath != null) {
        const customConfig = await loadConfigFile(existingConfigPath, { ...args, configDefaultConfig: result });
        customConfig.warnings.flush();
        return customConfig.options;
    }

    return result;

    function getCommonPlugins(config) {
        return [
            nodeResolve({ preferBuiltins: false, mainFields: ["module", "browser", "main"] }),
            isTypescript
                ? typescript({
                    noEmitOnError: !args.watch,
                    sourceMap: config.sourceMaps,
                    inlineSources: config.sourceMaps,
                    target: "es2022", // we transpile the result with babel anyway, see below
                    exclude: ["**/__tests__/**/*"]
                })
                : null,
            // Babel은 소스 JS와 결과 JS를 모두 트랜스파일할 수 있어서 입력/출력 플러그인이 있습니다.
            // 좋은 방법은 결과 코드에서 대부분의 변환을 수행하는 것입니다. 그래야 babel이 rollup/commonjs 플러그인이 
            // 사용하는 `import`와 `require`를 방해하지 않습니다. 또한 결과 코드에는 트랜스파일이 필요한 
            // 생성된 코드도 포함되어 있습니다.
            getBabelInputPlugin({
                sourceMaps: config.sourceMaps,
                babelrc: false,
                babelHelpers: "bundled",
                overrides: [
                    {
                        test: /node_modules/,
                        plugins: ["@babel/plugin-transform-flow-strip-types", "@babel/plugin-transform-react-jsx"]
                    },
                    {
                        exclude: /node_modules/,
                        plugins: [["@babel/plugin-transform-react-jsx", { pragma: "createElement" }]]
                    }
                ]
            }),
            commonjs({
                extensions: config.extensions,
                transformMixedEsModules: true,
                requireReturnsDefault: "auto",
                ignore: id => (config.external || []).some(value => new RegExp(value).test(id))
            }),
            replace({
                patterns: [
                    {
                        test: "process.env.NODE_ENV",
                        replace: production ? "'production'" : "'development'"
                    }
                ]
            }),
            config.transpile
                ? getBabelOutputPlugin({
                    sourceMaps: config.sourceMaps,
                    babelrc: false,
                    compact: false,
                    ...(config.babelConfig || {})
                })
                : null,
            image(),
            production ? terser({ mangle: false }) : null,
            // .mpk를 생성하고 번들링이 완료된 후 테스트 프로젝트에 결과물을 복사해야 합니다.
            // 일반 빌드의 경우 마지막 설정의 `writeBundle`에서 실행됩니다
            // (rollup이 설정을 순차적으로 처리하기 때문에). 하지만 watch 모드에서는 rollup이 
            // 변경된 설정만 다시 번들링하므로 => 어떤 것이 "마지막"이 될지 미리 알 수 없습니다.
            // 따라서 모든 설정에 대해 동일한 로직을 실행하고, 마지막 것이 우선하도록 합니다.
            command([
                async () => config.licenses && copyLicenseFile(sourcePath, outDir),
                async () =>
                    createMpkFile({
                        mpkDir,
                        mpkFile,
                        widgetTmpDir: outDir,
                        isProduction: production,
                        mxProjectPath: projectPath,
                        deploymentPath: "deployment/native/widgets"
                    })
            ])
        ];
    }

    function getClientComponentPlugins() {
        return [
            isTypescript ? widgetTyping({ sourceDir: join(sourcePath, "src") }) : null,
            clear({ targets: [outDir, mpkDir] }),
            command([
                () => {
                    cp(join(sourcePath, "src/**/*.xml"), outDir);
                    if (existsSync(`src/${widgetName}.icon.png`) || existsSync(`src/${widgetName}.tile.png`)) {
                        cp(join(sourcePath, `src/${widgetName}.@(tile|icon)?(.dark).png`), outDir);
                    }
                }
            ])
        ];
    }
};
