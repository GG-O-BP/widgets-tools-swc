/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import alias from "@rollup/plugin-alias";
import { getBabelInputPlugin, getBabelOutputPlugin } from "@rollup/plugin-babel";
import commonjs from "@rollup/plugin-commonjs";
import image from "@rollup/plugin-image";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import replace from "rollup-plugin-re";
import typescript from "@rollup/plugin-typescript";
import colors from "ansi-colors";
import postcssImport from "postcss-import";
import postcssUrl from "postcss-url";
import loadConfigFile from "rollup/dist/loadConfigFile.js";
import clear from "rollup-plugin-clear";
import command from "rollup-plugin-command";
import license from "rollup-plugin-license";
import livereload from "rollup-plugin-livereload";
import postcss from "rollup-plugin-postcss";
import terser from "@rollup/plugin-terser";
import shelljs from "shelljs";
import { widgetTyping } from "./rollup-plugin-widget-typing.mjs";
import {
    editorConfigEntry,
    isTypescript,
    previewEntry,
    projectPath,
    sourcePath,
    widgetEntry,
    widgetName,
    widgetPackage,
    widgetVersion,
    onwarn
} from "./shared.mjs";
import { copyLicenseFile, createMpkFile, licenseCustomTemplate } from "./helpers/rollup-helper.mjs";
import url from "./rollup-plugin-assets.mjs";

const { cp } = shelljs;

const outDir = join(sourcePath, "/dist/tmp/widgets/");
const outWidgetDir = join(widgetPackage.replace(/\./g, "/"), widgetName.toLowerCase());
const outWidgetFile = join(outWidgetDir, `${widgetName}`);
const absoluteOutPackageDir = join(outDir, outWidgetDir);
const mpkDir = join(sourcePath, "dist", widgetVersion);
const mpkFile = join(mpkDir, process.env.MPKOUTPUT ? process.env.MPKOUTPUT : `${widgetPackage}.${widgetName}.mpk`);
const assetsDirName = "assets";
const absoluteOutAssetsDir = join(absoluteOutPackageDir, assetsDirName);
const outAssetsDir = join(outWidgetDir, assetsDirName);

const imagesAndFonts = [
    "**/*.svg",
    "**/*.png",
    "**/*.jp(e)?g",
    "**/*.gif",
    "**/*.webp",
    "**/*.ttf",
    "**/*.woff(2)?",
    "**/*.eot"
];

const extensions = [".js", ".jsx", ".tsx", ".ts"];

const commonExternalLibs = [
    // "mendix" and internals under "mendix/"
    /^mendix($|\/)/,

    // "react"
    /^react$/,

    // "react/jsx-runtime"
    /^react\/jsx-runtime$/,

    // "react-dom"
    /^react-dom$/
];

const webExternal = [...commonExternalLibs, /^big.js$/];

/**
 * 이 함수는 postcss-url에서 사용됩니다.
 * 주요 목적은 스튜디오에서 CSS를 번들링한 후에도 
 * 에셋 경로가 올바르게 유지되도록 경로를 "조정"하는 것입니다.
 * 에셋을 복사하기 때문에 조정이 필요합니다 -- postcss-url은 파일을 복사할 수 있지만
 * 최종 URL은 *대상* 파일을 기준으로 상대 경로가 되어
 * 스튜디오(pro)에서 번들링 후 깨질 수 있습니다.
 *
 * 예시
 * 이전: assets/icon.png
 * 이후: com/mendix/widget/web/accordion/assets/icon.png
 */
const cssUrlTransform = asset =>
    asset.url.startsWith(`${assetsDirName}/`) ? `${outWidgetDir.replace(/\\/g, "/")}/${asset.url}` : asset.url;

export default async args => {
    const production = Boolean(args.configProduction);
    if (!production && projectPath) {
        console.info(colors.blue(`Project Path: ${projectPath}`));
    }

    const result = [];

    ["amd", "es"].forEach(outputFormat => {
        result.push({
            input: widgetEntry,
            output: {
                format: outputFormat,
                file: join(outDir, `${outWidgetFile}.${outputFormat === "es" ? "mjs" : "js"}`),
                sourcemap: !production ? "inline" : false
            },
            external: webExternal,
            plugins: [
                ...getClientComponentPlugins(),
                url({
                    include: imagesAndFonts,
                    limit: 0,
                    publicPath: `${join("widgets", outAssetsDir)}/`, // Mendix 웹 서버 루트를 기준으로 한 실제 임포트의 접두사
                    destDir: absoluteOutAssetsDir
                }),
                postCssPlugin(outputFormat, production),
                alias({
                    entries: {
                        "react-hot-loader/root": fileURLToPath(new URL("hot", import.meta.url)),
                    }
                }),
                ...getCommonPlugins({
                    sourceMaps: !production,
                    extensions,
                    transpile: production,
                    babelConfig: {
                        presets: [["@babel/preset-env", { targets: { safari: "12" } }]],
                        allowAllFormats: true
                    },
                    external: webExternal,
                    licenses: production && outputFormat === "amd"
                })
            ],
            onwarn: onwarn(args)
        });
    });

    if (previewEntry) {
        result.push({
            input: previewEntry,
            output: {
                format: "commonjs",
                file: join(outDir, `${widgetName}.editorPreview.js`),
                sourcemap: !production ? "inline" : false
            },
            external: commonExternalLibs,
            plugins: [
                postcss({
                    extensions: [".css", ".sass", ".scss"],
                    extract: false,
                    inject: true,
                    minimize: production,
                    plugins: [postcssImport(), postcssUrl({ url: "inline" })],
                    sourceMap: !production ? "inline" : false,
                    use: ["sass"]
                }),
                ...getCommonPlugins({
                    sourceMaps: !production,
                    extensions,
                    transpile: production,
                    babelConfig: { presets: [["@babel/preset-env", { targets: { safari: "12" } }]] },
                    external: commonExternalLibs
                })
            ],
            onwarn: onwarn(args)
        });
    }

    if (editorConfigEntry) {
        // Studio Pro의 JS 엔진은 es5만 지원하고 소스맵은 지원하지 않습니다
        result.push({
            input: editorConfigEntry,
            output: {
                format: "commonjs",
                file: join(outDir, `${widgetName}.editorConfig.js`),
                sourcemap: false
            },
            external: commonExternalLibs,
            strictDeprecations: true,
            treeshake: { moduleSideEffects: false },
            plugins: [
                url({ include: ["**/*.svg"], limit: 143360 }), // SVG file size limit of 140 kB
                ...getCommonPlugins({
                    sourceMaps: false,
                    extensions,
                    transpile: true,
                    babelConfig: { presets: [["@babel/preset-env", { targets: { ie: "11" } }]] },
                    external: commonExternalLibs
                }),
                {
                    closeBundle() {
                        if (!process.env.ROLLUP_WATCH) {
                            setTimeout(() => process.exit(0));
                        }
                    },
                    name: 'force-close'
                }
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
            production ? terser() : null,
            config.licenses
                ? license({
                    thirdParty: {
                        includePrivate: true,
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
                })
                : null,
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
                        deploymentPath: "deployment/web/widgets"
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
            ]),
            args.watch && !production && projectPath ? livereload() : null
        ];
    }
};

export function postCssPlugin(outputFormat, production, postcssPlugins = []) {
    return postcss({
        extensions: [".css", ".sass", ".scss"],
        extract: outputFormat === "amd",
        inject: false,
        minimize: production,
        plugins: [
            postcssImport(),
            /**
             * 스튜디오(pro)에서 최종 스타일 번들링을 위해 postcss-url 복사본 두 개가 필요합니다.
             * 아래 줄에서는 위젯 번들 디렉토리(com.mendix.widgets...)로 에셋을 복사하기만 합니다.
             * 이 플러그인이 작동하려면 다음 요구사항이 필요합니다:
             * 1. 에셋을 src/assets/에 넣어야 합니다
             * 2. .scss 파일에서 상대 경로를 사용해야 합니다 (예: url(../assets/icon.png))
             * 3. 이 플러그인은 postcss 플러그인의 `to` 속성에 의존하며, 파일을 대상 위치로
             * 복사할 때 이 속성이 있어야 합니다.
             */
            postcssUrl({ url: "copy", assetsPath: "assets" }),
            /**
             * 이 postcss-url 인스턴스는 에셋 경로를 조정하기 위한 것입니다.
             * 자세한 설명은 *createCssUrlTransform* 문서 주석을 확인하세요.
             */
            postcssUrl({ url: cssUrlTransform }),
            ...postcssPlugins
        ],
        sourceMap: !production ? "inline" : false,
        use: ["sass"],
        to: join(outDir, `${outWidgetFile}.css`)
    });
}
