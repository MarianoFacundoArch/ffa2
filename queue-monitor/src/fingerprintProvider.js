import fs from 'node:fs';
import path from 'node:path';
import { dirs } from './config.js';

const CONFIG_FILENAME = 'fingerprint.config.json';
const API_ENV_KEYS = ['FINGERPRINT_API_KEY', 'PLAYWRIGHT_FINGERPRINT_API_KEY', 'FP_SWITCHER_TOKEN'];
const DEFAULT_API_KEY = 'P40o1xL0dcN2sgTw4WktX985h77ieF5SP84cQTb0m4sjvg60ideAjSsDrCqyCpZC';

let cachedConfig = null;
let fingerprintPlugin = null;
let libraryLoadAttempted = false;

function loadConfig() {
  if (cachedConfig !== null) {
    return cachedConfig;
  }
  const configPath = path.join(dirs.rootDir, CONFIG_FILENAME);
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      cachedConfig = JSON.parse(raw);
      return cachedConfig;
    } catch (error) {
      console.warn('[fingerprint] Failed to parse fingerprint.config.json:', error.message);
    }
  }
  cachedConfig = {};
  return cachedConfig;
}

function resolveApiKey() {
  for (const key of API_ENV_KEYS) {
    if (process.env[key] && process.env[key].trim()) {
      return process.env[key].trim();
    }
  }
  if (DEFAULT_API_KEY) {
    return DEFAULT_API_KEY;
  }
  return null;
}

async function ensureFingerprintPlugin(apiKey) {
  if (fingerprintPlugin || libraryLoadAttempted) {
    return fingerprintPlugin;
  }
  libraryLoadAttempted = true;
  try {
    const mod = await import('playwright-with-fingerprints');
    const plugin = mod?.plugin || mod?.default?.plugin || null;
    if (!plugin) {
      console.warn('[fingerprint] playwright-with-fingerprints module loaded but no plugin found');
      return null;
    }
    // Set the service key (API key)
    if (apiKey) {
      plugin.setServiceKey(apiKey);
    }
    fingerprintPlugin = plugin;
    return fingerprintPlugin;
  } catch (error) {
    console.warn('[fingerprint] Unable to load playwright-with-fingerprints, falling back to default context:', error.message);
    return null;
  }
}

export async function launchFingerprintContext({ profileDir, launchOptions }) {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    return null;
  }

  const plugin = await ensureFingerprintPlugin(apiKey);
  if (!plugin) {
    return null;
  }

  const config = loadConfig();
  const fingerprintTags = config.fingerprintOptions?.tags || ['Microsoft Windows', 'Chrome'];

  try {
    // Fetch a fingerprint with specified tags
    const fingerprint = await plugin.fetch({
      tags: fingerprintTags,
    });

    if (!fingerprint) {
      console.warn('[fingerprint] Failed to fetch fingerprint, using default context');
      return null;
    }

    // Apply the fingerprint
    plugin.useFingerprint(fingerprint);

    // Use launchPersistentContext (recommended by the plugin)
    const context = await plugin.launchPersistentContext(profileDir, {
      headless: launchOptions?.headless ?? false,
      args: launchOptions?.args || [],
      viewport: { width: 1280, height: 720 },
      ...(config.launchOptions || {}),
    });

    if (!context) {
      console.warn('[fingerprint] Context launch failed, using default context');
      return null;
    }

    // Get or create page
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    return {
      context,
      page,
      fingerprint,
    };
  } catch (error) {
    console.warn('[fingerprint] Fingerprint launch failed, using default context:', error.message);
    return null;
  }
}
