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
  // Store rules by chunk name/id instead of globally
  stylexRulesByChunk = {};
  filesInLastRun = null;
  // Map files to their chunks for organization
  fileToChunkMap = {};

  constructor({
                dev = IS_DEV_ENV,
                appendTo,
                filename = appendTo == null ? '[name].stylex.css' : undefined, // Use [name] token to include chunk name
                stylexImports = ['stylex', '@stylexjs/stylex'],
                unstable_moduleResolution = { type: 'commonJS', rootDir: process.cwd() },
                babelConfig: { plugins = [], presets = [], babelrc = false } = {},
                useCSSLayers = false,
                ...options
              } /*: PluginOptions */ = {}) {
    this.dev = dev;
    this.appendTo = appendTo;
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

    compiler.hooks.beforeCompile.tap(PLUGIN_NAME, (params) => {
      // Reset the data structures to prevent memory leaks
      this.stylexRulesByChunk = {};
      this.fileToChunkMap = {};
      this.filesInLastRun = null;
    });

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

      // Track which files belong to which chunks
      compilation.hooks.buildModule.tap(PLUGIN_NAME, (module) => {
        if (module.resource) {
          // Initialize empty array for this file if it doesn't exist
          this.fileToChunkMap[module.resource] = [];
        }
      });

      // Map modules to chunks when chunks are created
      compilation.hooks.chunkAsset.tap(PLUGIN_NAME, (chunk, filename) => {
        // Find all modules in this chunk
        for (const module of chunk.getModules()) {
          if (module.resource && this.fileToChunkMap[module.resource]) {
            // Add this chunk to the file's chunks if not already there
            if (!this.fileToChunkMap[module.resource].includes(chunk.name || chunk.id)) {
              this.fileToChunkMap[module.resource].push(chunk.name || chunk.id);
            }
          }
        }
      });

      // Make a list of all modules that were included in the last compilation.
      // This might need to be tweaked if not all files are included after a change
      compilation.hooks.finishModules.tap(PLUGIN_NAME, (modules) => {
        this.filesInLastRun = [...modules.values()].map((m) => m.resource);
      });

      // Group rules by chunk and return processed CSS for each chunk
      const getStyleXRulesByChunk = () => {
        // Initialize an object to store rules by chunk
        const rulesByChunk = {};

        // Go through each file that has StyleX rules
        for (const filename of Object.keys(this.stylexRulesByChunk)) {
          // Skip files that weren't in last compilation
          if (this.filesInLastRun && !this.filesInLastRun.includes(filename)) {
            continue;
          }

          // Get the chunks this file belongs to
          const chunks = this.fileToChunkMap[filename] || ['main']; // Default to 'main' if no chunk info

          // Add this file's rules to each chunk it belongs to
          for (const chunkName of chunks) {
            if (!rulesByChunk[chunkName]) {
              rulesByChunk[chunkName] = [];
            }
            rulesByChunk[chunkName].push(...this.stylexRulesByChunk[filename]);
          }
        }

        // Process rules for each chunk
        const cssPerChunk = {};
        for (const [chunkName, rules] of Object.entries(rulesByChunk)) {
          if (rules.length > 0) {
            cssPerChunk[chunkName] = stylexBabelPlugin.processStylexRules(
              rules,
              this.useCSSLayers
            );
          }
        }
        return cssPerChunk;
      };

      if (this.appendTo) {
        compilation.hooks.processAssets.tap(
          {
            name: PLUGIN_NAME,
            stage: Compilation.PROCESS_ASSETS_STAGE_PRE_PROCESS,
          },
          (assets) => {
            // Get CSS rules grouped by chunk
            const cssPerChunk = getStyleXRulesByChunk();

            // For each chunk that has CSS
            for (const [chunkName, chunkCSS] of Object.entries(cssPerChunk)) {
              if (!chunkCSS) continue;

              // Try to find a matching CSS file for this chunk
              const chunkPattern = new RegExp(`${chunkName}.*${this.appendTo}`);
              const cssFileName = Object.keys(assets).find(filename =>
                chunkPattern.test(filename) ||
                (typeof this.appendTo === 'function' && this.appendTo(filename))
              );

              if (cssFileName) {
                const cssAsset = assets[cssFileName];
                assets[cssFileName] = new ConcatSource(
                  cssAsset,
                  new RawSource(chunkCSS),
                );
              }
            }
          },
        );
      } else {
        // We'll emit an asset ourselves with separate CSS file per chunk
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

        // Consume collected rules and emit stylex CSS assets for each chunk
        compilation.hooks.processAssets.tap(
          {
            name: PLUGIN_NAME,
            stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
          },
          () => {
            try {
              // Get CSS organized by chunk
              const cssPerChunk = getStyleXRulesByChunk();

              // Create a CSS file for each chunk
              for (const [chunkName, chunkCSS] of Object.entries(cssPerChunk)) {
                if (!chunkCSS) continue;

                // Generate content hash for this chunk's CSS
                const contentHash = getContentHash(chunkCSS);

                // Create data for filename template processing
                const data = {
                  filename: this.filename,
                  contentHash: contentHash,
                  chunk: {
                    id: chunkName,
                    name: chunkName,
                    hash: contentHash,
                  },
                };

                // Process the filename template (replacing [name], [contenthash], etc.)
                const { path: hashedPath, info: assetsInfo } =
                  compilation.getPathWithInfo(this.filename, data);

                // Emit the asset for this chunk
                compilation.emitAsset(
                  hashedPath,
                  new RawSource(chunkCSS),
                  assetsInfo,
                );
              }
            } catch (e) {
              compilation.errors.push(e);
            }
          },
        );
      }
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

          plugins: [
            ...this.babelConfig.plugins,
            path.extname(filename) === '.ts'
              ? typescriptSyntaxPlugin
              : [typescriptSyntaxPlugin, { isTSX: true }],
            jsxSyntaxPlugin,
            this.babelPlugin],
          presets: this.babelConfig.presets,
        },
      );
      if (metadata.stylex != null && metadata.stylex.length > 0) {
        this.stylexRulesByChunk[filename] = metadata.stylex;
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