/**
 * This plugin's version, compiled into the bundle.
 *
 * Paseo evaluates the server bundle from a string, so the running code has no
 * `import.meta.url` or `__dirname` to say which install directory it came from. Its
 * version is the one thing it carries that the directory on disk also carries
 * (`package.json`), which is how `resolvePluginDir()` tells the install that is running
 * from a stale one during an update. `version.test.ts` keeps it equal to `package.json`.
 */
export const PLUGIN_VERSION = "3.7.0-beta.4";
