import fs from 'fs';
import path from 'path';

export type UpdatePackageType = 'installer' | 'portable';

export interface VersionManifest {
  latestVersion: string;
  downloadUrl: string;
  packageType: UpdatePackageType;
  checksum: string | null;
  releaseNotes: string | null;
  releasePageUrl: string;
  sourceLabel: string;
  assetName: string;
  generatedAt: string;
}

export interface ManifestBuildOptions {
  version: string;
  packageType?: UpdatePackageType;
  releaseNotes?: string | null;
  checksum?: string | null;
}

export const GITHUB_OWNER = 'samuellucky2424-afk';
export const GITHUB_REPO = 'techlordmedia';
export const GITHUB_REPOSITORY_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;
export const GITHUB_RELEASES_URL = `${GITHUB_REPOSITORY_URL}/releases`;

export function normalizePackageType(value: unknown): UpdatePackageType {
  return value === 'portable' ? 'portable' : 'installer';
}

export function normalizeVersion(version: string): string {
  return version.trim();
}

export function buildAssetName(version: string, packageType: UpdatePackageType): string {
  const safeVersion = normalizeVersion(version);
  return packageType === 'portable'
    ? `Tech Lord Media ${safeVersion}.exe`
    : `Tech Lord Media Setup ${safeVersion}.exe`;
}

export function buildReleasePageUrl(version: string): string {
  return `${GITHUB_REPOSITORY_URL}/releases/tag/v${normalizeVersion(version)}`;
}

export function buildDownloadUrl(version: string, packageType: UpdatePackageType): string {
  const assetName = buildAssetName(version, packageType);
  return `${GITHUB_REPOSITORY_URL}/releases/download/v${normalizeVersion(version)}/${encodeURIComponent(assetName)}`;
}

function readTextFileIfExists(filePath: string): string | null {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const contents = fs.readFileSync(filePath, 'utf8').trim();
    return contents || null;
  } catch {
    return null;
  }
}

function readEnvText(env: NodeJS.ProcessEnv, keys: string[]): string | null {
  for (const key of keys) {
    const value = env[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function resolveReleaseNotes(env: NodeJS.ProcessEnv = process.env): string | null {
  const inlineNotes = readEnvText(env, ['SUREVIDEOTOOL_RELEASE_NOTES', 'RELEASE_NOTES']);
  if (inlineNotes) return inlineNotes;

  const notesFile = readEnvText(env, ['SUREVIDEOTOOL_RELEASE_NOTES_FILE']);
  if (notesFile) return readTextFileIfExists(path.resolve(notesFile));

  return null;
}

export function resolveChecksum(packageType: UpdatePackageType, env: NodeJS.ProcessEnv = process.env): string | null {
  const scopedKey = packageType === 'portable'
    ? ['SUREVIDEOTOOL_UPDATE_SHA256_PORTABLE', 'SUREVIDEOTOOL_UPDATE_CHECKSUM_PORTABLE']
    : ['SUREVIDEOTOOL_UPDATE_SHA256_INSTALLER', 'SUREVIDEOTOOL_UPDATE_CHECKSUM_INSTALLER'];

  const generic = readEnvText(env, ['SUREVIDEOTOOL_UPDATE_SHA256', 'SUREVIDEOTOOL_UPDATE_CHECKSUM']);
  return readEnvText(env, scopedKey) ?? generic;
}

export function createVersionManifest(options: ManifestBuildOptions): VersionManifest {
  const version = normalizeVersion(options.version);
  const packageType = options.packageType ?? 'installer';
  const assetName = buildAssetName(version, packageType);

  return {
    latestVersion: version,
    downloadUrl: buildDownloadUrl(version, packageType),
    packageType,
    checksum: options.checksum ?? null,
    releaseNotes: options.releaseNotes ?? null,
    releasePageUrl: buildReleasePageUrl(version),
    sourceLabel: 'GitHub Releases',
    assetName,
    generatedAt: new Date().toISOString()
  };
}
