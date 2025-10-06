import fs from 'node:fs';
import path from 'node:path';
import { dirs } from './config.js';

const CONFIG_FILENAME = 'fingerprint.config.json';
const API_ENV_KEYS = ['FINGERPRINT_API_KEY', 'PLAYWRIGHT_FINGERPRINT_API_KEY', 'FP_SWITCHER_TOKEN'];
const DEFAULT_API_KEY = 'P40o1xL0dcN2sgTw4WktX985h77ieF5SP84cQTb0m4sjvg60ideAjSsDrCqyCpZC';

let cachedConfig = null;
let fingerprintClient = null;
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

async function ensureFingerprintClient(apiKey) {
  if (fingerprintClient || libraryLoadAttempted) {
    return fingerprintClient;
  }
  libraryLoadAttempted = true;
  try {
    const mod = await import('playwright-with-fingerprints');
    const Constructor =
      mod?.default || mod?.PlaywrightWithFingerprints || mod?.FingerprintSwitcher || null;
    if (!Constructor) {
      console.warn('[fingerprint] playwright-with-fingerprints module loaded but no constructor found');
      return null;
    }
    const config = loadConfig();
    const clientOptions = config.clientOptions || {};
    fingerprintClient = new Constructor({ token: apiKey, ...clientOptions });
    return fingerprintClient;
  } catch (error) {
    console.warn('[fingerprint] Unable to load playwright-with-fingerprints, falling back to default context:', error.message);
    return null;
  }
}

export async function launchFingerprintContext({ profileDir, launchOptions, contextOptions }) {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    return null;
  }

  const client = await ensureFingerprintClient(apiKey);
  if (!client) {
    return null;
  }

  const config = loadConfig();
  const fingerprintOptions = config.fingerprintOptions || {};
  const finalLaunchOptions = {
    headless: launchOptions?.headless ?? false,
    args: launchOptions?.args || [],
    userDataDir: profileDir,
    ...(config.launchOptions || {}),
  };
  const finalContextOptions = {
    ...contextOptions,
    ...(config.contextOptions || {}),
  };

  try {
    const result = await client.launch({
      launchOptions: finalLaunchOptions,
      contextOptions: finalContextOptions,
      fingerprintOptions,
    });
    if (!result || !result.context) {
      console.warn('[fingerprint] Fingerprint service did not return a context, using default');
      return null;
    }
    return {
      context: result.context,
      page: result.page || null,
      fingerprint: result.fingerprint || null,
    };
  } catch (error) {
    console.warn('[fingerprint] Fingerprint launch failed, using default context:', error.message);
    return null;
  }
}
