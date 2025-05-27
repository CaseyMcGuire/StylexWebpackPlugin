import type { LoaderContext } from 'webpack';

const PLUGIN_NAME = 'stylex';

type WebpackLogger = ReturnType<LoaderContext<any>['getLogger']>;

interface StylexLoaderOptions {
  stylexPlugin: StylexPlugin;
  [key: string]: any;
}


interface StylexPlugin {
  transformCode: (
    inputCode: string,
    resourcePath: string,
    logger: WebpackLogger,
  ) => Promise<{ code: string; map?: any }>;
}

export default function stylexLoader(
  this: LoaderContext<StylexLoaderOptions>,
  inputCode: string,
): void {
  const callback = this.async();

  const options = this.getOptions();

  if (!options || typeof options.stylexPlugin?.transformCode !== 'function') {
    callback(
      new Error(
        `${PLUGIN_NAME} loader: The 'stylexPlugin' option with a 'transformCode' method was not provided. ` +
        `Please ensure it's configured correctly in your webpack.config.js.`,
      ),
    );
    return;
  }

  const { stylexPlugin } = options;

    const logger = this.getLogger(PLUGIN_NAME);

  stylexPlugin
    .transformCode(inputCode, this.resourcePath, logger)
    .then(
      ({ code, map }) => {
        // The callback expects: Error | null, content?, sourceMap?, meta?
        callback(null, code, map);
      },
      (error: any) => { // Catching 'any' error and ensuring it's an Error object
        if (error instanceof Error) {
          callback(error);
        } else {
          // If it's not an Error instance, wrap it
          callback(new Error(String(error || 'Unknown error in stylexPlugin.transformCode')));
        }
      },
    );
}
