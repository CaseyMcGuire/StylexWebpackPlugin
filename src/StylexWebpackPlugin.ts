import {Compilation, Compiler, NormalModule, sources} from 'webpack';
import path from "path";
import stylexBabelPlugin from "@stylexjs/babel-plugin";
import fs from "fs/promises";
import {transformAsync} from "@babel/core";

// @ts-ignore
import jsxSyntaxPlugin from "@babel/plugin-syntax-jsx";

// @ts-ignore
import typescriptSyntaxPlugin from "@babel/plugin-syntax-typescript";
import StyleXTransformObj from "@stylexjs/babel-plugin";
import {StyleXOptions} from "@stylexjs/babel-plugin/lib/utils/state-manager";

interface StylexWebpackPluginOptions {
  dev: boolean,
  useCSSLayers: boolean
}

const IS_DEV_ENV =
  process.env.NODE_ENV === 'development' ||
  process.env.BABEL_ENV === 'development';

const PLUGIN_NAME = "stylex";

export default class StylexWebpackPlugin {

  private fileToBundlesMap: Map<string, Set<string>>
  private stylexRules: Map<string, string[]>
  private stylexImports = ['stylex', '@stylexjs/stylex']
  private babelConfig: {
    plugins: any[],
    presets: any[],
    babelrc: boolean
  }
  private babelPlugin: [typeof StyleXTransformObj, Partial<StyleXOptions>]

  constructor(options: StylexWebpackPluginOptions = {
    dev: IS_DEV_ENV,
    useCSSLayers: false
  }) {
    this.fileToBundlesMap = new Map<string, Set<string>>();
    this.stylexRules = new Map<string, string[]>(); // Missing initialization
    this.babelConfig = {
      plugins: [],
      presets: [],
      babelrc: false
    };
    this.babelPlugin = [
      stylexBabelPlugin,
      {
        dev: options.dev,
      }
    ];
  }

  apply(compiler: Compiler) {
    compiler.hooks.make.tap(PLUGIN_NAME, (compilation) => {
      NormalModule.getCompilationHooks(compilation).loader.tap(
        PLUGIN_NAME,
        (loaderContext, module: NormalModule) => {
          if (
            // .js, .jsx, .mjs, .cjs, .ts, .tsx, .mts, .cts
            /\.[mc]?[jt]sx?$/.test(path.extname(module.resource))
          ) {
            // It might make sense to use .push() here instead of .unshift()
            // Webpack usually runs loaders in reverse order and we want to ideally run
            // our loader before anything else.
            module.loaders.unshift({
              loader: path.resolve(__dirname, 'loader.js'),
              options: {stylexPlugin: this},
              ident: null,
              type: null
            });
          }
        }
      )

      compilation.hooks.afterOptimizeChunks.tap(PLUGIN_NAME, (chunks) => {
        this.fileToBundlesMap = new Map<string, Set<string>>(); // Reset map for each compilation

        for (const chunk of chunks) {
          const chunkName = chunk.name || chunk.id?.toString() || `chunk-${chunk.renderedHash}`;
          if (!chunkName) continue; // Should always have a name/id/hash
          for (const module of compilation.chunkGraph.getChunkModules(chunk)) {
            const normalModule = module as NormalModule
            if (normalModule.resource) {
              const filePath = normalModule.resource;
              const isNodeModule = filePath.includes(path.sep + 'node_modules' + path.sep);

              if (!isNodeModule) {
                if (!this.fileToBundlesMap.get(filePath)) {
                  this.fileToBundlesMap.set(filePath, new Set<string>());
                }
                // Add bundle name to the file's list if not already present
                if (!this.fileToBundlesMap.get(filePath)!.has(chunkName)) {
                  this.fileToBundlesMap.get(filePath)!.add(chunkName);
                }
              }
            }
          }
        }
      });

      const getBundleToStylexRules = () => {

        if (this.stylexRules.size === 0) {
          return null;
        }

        const bundleToRules: { [key: string]: any } = {};
        for (const filename of this.stylexRules.keys()) {
          const bundles = this.fileToBundlesMap.get(filename)
          if (bundles == null) {
            continue
          }
          for (const bundle of bundles) {
            if (!bundleToRules[bundle]) {
              bundleToRules[bundle] = []
            }
            bundleToRules[bundle].push(...this.stylexRules.get(filename)!!)
          }
        }

        const bundleToProcessedRules: Record<string, string> = {}
        for (const bundle in bundleToRules) {
          bundleToProcessedRules[bundle] =
            stylexBabelPlugin.processStylexRules(
              bundleToRules[bundle],
              false,
            );
        }

        return bundleToProcessedRules;
      };

      // We'll emit an asset ourselves. This comes with some complications in from Webpack.
      // If the filename contains replacement tokens, like [contenthash], we need to
      // process those tokens ourselves. Webpack does provide a way to reuse the configured
      // hashing functions. We'll take advantage of that to process tokens.
      const getContentHash = (source: string) => {
        const {outputOptions} = compilation;
        const {hashDigest, hashDigestLength, hashFunction, hashSalt} =
          outputOptions;
        const hash = compiler.webpack.util.createHash(hashFunction!);

        if (hashSalt) {
          hash.update(hashSalt);
        }

        hash.update(source);

        const fullContentHash = hash.digest(hashDigest);

        return fullContentHash.toString().slice(0, hashDigestLength);
      };

      // Consume collected rules and emit the stylex CSS assets
      compilation.hooks.processAssets.tap(
        {
          name: PLUGIN_NAME,
          stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        },
        () => {
          try {
            const bundleToStylexRules = getBundleToStylexRules();

            if (bundleToStylexRules) {
              for (const bundle of Object.keys(bundleToStylexRules)) {
                const collectedCSS = bundleToStylexRules[bundle]

                // build up a content hash for the rules using webpack's configured hashing functions
                const contentHash = getContentHash(collectedCSS);

                // pretend to be a chunk so we can reuse the webpack routine to process the filename and do token replacement
                // see https://github.com/webpack/webpack/blob/main/lib/Compilation.js#L4733
                // see https://github.com/webpack/webpack/blob/main/lib/TemplatedPathPlugin.js#L102
                const filename = `${bundle}.stylex.css`
                const data = {
                  filename: filename,
                  contentHash: contentHash,
                  chunk: {
                    id: filename,
                    name: path.parse(filename).name,
                    hash: contentHash,
                  },
                };

                const {path: hashedPath, info: assetsInfo} =
                  compilation.getPathWithInfo(data.filename, data);
                compilation.emitAsset(
                  hashedPath,
                  new sources.RawSource(collectedCSS),
                  assetsInfo,
                );
              }
            }
          } catch (e) {
            compilation.errors.push(e);
          }
        },
      );
    })

  }

  async transformCode(inputCode: string, filename: string, logger: { debug: (arg0: string, arg1: any) => void; }) {
    if (
      this.stylexImports.some((importName) => inputCode.includes(importName))
    ) {
      const originalSource = this.babelConfig.babelrc
        ? await fs.readFile(filename, 'utf8')
        : inputCode;

      const result = await transformAsync(
        originalSource,
        {
          babelrc: this.babelConfig.babelrc,
          filename,
          // Use TypeScript syntax plugin if the filename ends with `.ts` or `.tsx`
          // and use the Flow syntax plugin otherwise.
          plugins: [
            ...this.babelConfig.plugins,
            path.extname(filename) === '.ts'
              ? typescriptSyntaxPlugin
              : [typescriptSyntaxPlugin, { isTSX: true }],
            jsxSyntaxPlugin,
            this.babelPlugin,
          ],
          presets: this.babelConfig.presets,
        },
      );

      if (result == null) {
        logger.debug(`No result from compilation`, originalSource)
        throw new Error("Failed compilation")
      }
      const { code, map, metadata } = result
      // @ts-ignore
      const stylexMetadata = metadata.stylex

      if (stylexMetadata != null && stylexMetadata.length > 0) {
        this.stylexRules.set(filename, stylexMetadata);
        logger.debug(`Read stylex styles from ${filename}:`, stylexMetadata);
      }
      if (!this.babelConfig.babelrc) {
        return { code, map };
      }
    }
    return { code: inputCode };
  }
}