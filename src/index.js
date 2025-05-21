const babel = require('@babel/core');
const path = require('path');
const stylexBabelPlugin = require('@stylexjs/babel-plugin');
const webpack = require('webpack');
const jsxSyntaxPlugin = require('@babel/plugin-syntax-jsx');
const typescriptSyntaxPlugin = require('@babel/plugin-syntax-typescript');
const fs = require('fs/promises');

const { NormalModule, Compilation } = webpack;

const PLUGIN_NAME = 'stylex';

const IS_DEV_ENV =
  process.env.NODE_ENV === 'development' ||
  process.env.BABEL_ENV === 'development';

const { RawSource, ConcatSource } = webpack.sources;


class StylexPlugin {
  stylexRules = {};
  filesInLastRun = null;

  constructor({
                dev = IS_DEV_ENV,
                appendTo,
                filename = appendTo == null ? '[name].stylex.css' : undefined,
                stylexImports = ['stylex', '@stylexjs/stylex'],
                unstable_moduleResolution = { type: 'commonJS', rootDir: process.cwd() },
                babelConfig: { plugins = [], presets = [], babelrc = false } = {},
                useCSSLayers = false,
                ...options
              } /*: PluginOptions */ = {}) {
    this.dev = dev;
    this.filename = filename;
    this.babelConfig = { plugins, presets, babelrc };
    this.stylexImports = stylexImports;
    this.babelPlugin = [
      stylexBabelPlugin,
      {
        dev,
        unstable_moduleResolution,
        importSources: stylexImports,
        ...options,
      },
    ];
    this.useCSSLayers = useCSSLayers;
  }

  apply(compiler) {
    compiler.hooks.make.tap(PLUGIN_NAME, (compilation) => {
      // Apply loader to JS modules.
      NormalModule.getCompilationHooks(compilation).loader.tap(
        PLUGIN_NAME,
        (loaderContext, module) => {
          if (
            // .js, .jsx, .mjs, .cjs, .ts, .tsx, .mts, .cts
            /\.[mc]?[jt]sx?$/.test(path.extname(module.resource))
          ) {
            // It might make sense to use .push() here instead of .unshift()
            // Webpack usually runs loaders in reverse order and we want to ideally run
            // our loader before anything else.
            module.loaders.unshift({
              loader: path.resolve(__dirname, 'loader.js'),
              options: { stylexPlugin: this },
            });
          }
        },
      );

      // Make a list of all modules that were included in the last compilation.
      // This might need to be tweaked if not all files are included after a change
      compilation.hooks.finishModules.tap(PLUGIN_NAME, (modules) => {
        this.filesInLastRun = [...modules.values()].map((m) => m.resource);
      });

      compilation.hooks.afterOptimizeChunks.tap(PLUGIN_NAME, (chunks) => {
        // --- CHANGED PROPERTY NAME AND LOGIC ---
        this.fileToBundlesMap = {}; // Reset map for each compilation

        for (const chunk of chunks) {
          const chunkName = chunk.name || chunk.id?.toString() || `chunk-${chunk.renderedHash}`;
          if (!chunkName) continue; // Should always have a name/id/hash
          for (const module of compilation.chunkGraph.getChunkModules(chunk)) {
            if (module.resource) {
              const filePath = module.resource;
              const isNodeModule = filePath.includes(path.sep + 'node_modules' + path.sep);

              if (!isNodeModule) {
                if (!this.fileToBundlesMap[filePath]) {
                  this.fileToBundlesMap[filePath] = [];
                }
                // Add bundle name to the file's list if not already present
                if (!this.fileToBundlesMap[filePath].includes(chunkName)) {
                  this.fileToBundlesMap[filePath].push(chunkName);
                }
              }
            }
          }
        }
        // You can log it here for debugging if needed:
        //console.log('File to Bundles Map (excluding node_modules):', this.fileToBundlesMap);
      });

      const getBundleToStylexRules = () => {
        const { stylexRules } = this;
        if (Object.keys(stylexRules).length === 0) {
          return null;
        }
        // Take styles for the modules that were included in the last compilation.

        const bundleToRules = {};
        for (const filename in stylexRules) {
          const bundles = this.fileToBundlesMap[filename]
          if (bundles == null) {
            continue
          }
          for (const bundle of bundles) {
            if (!bundleToRules[bundle]) {
              bundleToRules[bundle] = []
            }
            bundleToRules[bundle].push(...stylexRules[filename])
          }
        }

        const bundleToProcessedRules = {}
        for (const bundle in bundleToRules) {
          bundleToProcessedRules[bundle] =
            stylexBabelPlugin.processStylexRules(
              bundleToRules[bundle],
              this.useCSSLayers,
            );
        }

        return bundleToProcessedRules;
      };

      // We'll emit an asset ourselves. This comes with some complications in from Webpack.
      // If the filename contains replacement tokens, like [contenthash], we need to
      // process those tokens ourselves. Webpack does provide a way to reuse the configured
      // hashing functions. We'll take advantage of that to process tokens.
      const getContentHash = (source) => {
        const { outputOptions } = compilation;
        const { hashDigest, hashDigestLength, hashFunction, hashSalt } =
          outputOptions;
        const hash = compiler.webpack.util.createHash(hashFunction);

        if (hashSalt) {
          hash.update(hashSalt);
        }

        hash.update(source);

        const fullContentHash = hash.digest(hashDigest);

        return fullContentHash.toString().slice(0, hashDigestLength);
      };
      // Consume collected rules and emit the stylex CSS asset
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

                const { path: hashedPath, info: assetsInfo } =
                  compilation.getPathWithInfo(data.filename, data);
                compilation.emitAsset(
                  hashedPath,
                  new RawSource(collectedCSS),
                  assetsInfo,
                );
              }
            }
          } catch (e) {
            compilation.errors.push(e);
          }
        },
      );

    });
  }

  // This function is not called by Webpack directly.
  // Instead, `NormalModule.getCompilationHooks` is used to inject a loader
  // for JS modules. The loader than calls this function.
  async transformCode(inputCode, filename, logger) {
    if (
      this.stylexImports.some((importName) => inputCode.includes(importName))
    ) {
      const originalSource = this.babelConfig.babelrc
        ? await fs.readFile(filename, 'utf8')
        : inputCode;
      const { code, map, metadata } = await babel.transformAsync(
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
      if (metadata.stylex != null && metadata.stylex.length > 0) {
        this.stylexRules[filename] = metadata.stylex;
        logger.debug(`Read stylex styles from ${filename}:`, metadata.stylex);
      }
      if (!this.babelConfig.babelrc) {
        return { code, map };
      }
    }
    return { code: inputCode };
  }
}

module.exports = StylexPlugin;