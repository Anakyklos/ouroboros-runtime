/**
 * 🛡️ SandboxPathUtils
 *
 * Path validation and sandbox confinement utilities for secure file access.
 * Prevents path traversal attacks, symlink escapes, and unauthorized file access.
 *
 * @module runtime/SandboxPathUtils
 */

import { resolve, normalize, isAbsolute, relative } from 'path';
import { realpath, stat } from 'fs/promises';

// ============================================================================
// Types
// ============================================================================

export interface PathValidationResult {
    valid: boolean;
    resolvedPath: string;
    error?: string;
}

export interface PathAccessConfig {
    /** Allowed directories for file access (whitelist) */
    allowedDirectories: string[];
    /** Whether to allow symlinks (default: false for security) */
    allowSymlinks?: boolean;
    /** Whether to allow absolute paths (default: false) */
    allowAbsolutePaths?: boolean;
    /** Maximum path length (default: 4096) */
    maxPathLength?: number;
}

export interface SandboxPathContext {
    /** Base directory for sandbox operations */
    sandboxDir: string;
    /** Playground directory within sandbox */
    playgroundDir: string;
    /** Additional allowed directories */
    allowedDirs?: string[];
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: Required<Omit<PathAccessConfig, 'allowedDirectories'>> = {
    allowSymlinks: false,
    allowAbsolutePaths: false,
    maxPathLength: 4096,
};

const PATH_TRAVERSAL_PATTERN = /\.\./;
const NULL_BYTE_PATTERN = /\0/;
const WINDOWS_ABSOLUTE_DRIVE_PATTERN = /^[a-zA-Z]:\\/;

// ============================================================================
// Path Validation Functions
// ============================================================================

/**
 * Validates that a path is safe and within allowed directories
 * Resolves symlinks and checks the real path to prevent escapes
 */
export async function validatePath(
    inputPath: string,
    config: PathAccessConfig
): Promise<PathValidationResult> {
    const { allowedDirectories } = config;

    // Normalize config
    const normalizedConfig = { ...DEFAULT_CONFIG, ...config };

    // Check for null bytes (prevent null byte injection)
    if (NULL_BYTE_PATTERN.test(inputPath)) {
        return {
            valid: false,
            resolvedPath: inputPath,
            error: 'Path contains null byte',
        };
    }

    // Check path length
    if (inputPath.length > normalizedConfig.maxPathLength) {
        return {
            valid: false,
            resolvedPath: inputPath,
            error: `Path exceeds maximum length of ${normalizedConfig.maxPathLength}`,
        };
    }

    // Check for obvious path traversal patterns (before normalization)
    if (PATH_TRAVERSAL_PATTERN.test(inputPath)) {
        return {
            valid: false,
            resolvedPath: inputPath,
            error: 'Path contains traversal sequence (..)',
        };
    }

    // Check if absolute path is allowed
    if (isAbsolute(inputPath) || WINDOWS_ABSOLUTE_DRIVE_PATTERN.test(inputPath)) {
        if (!normalizedConfig.allowAbsolutePaths) {
            return {
                valid: false,
                resolvedPath: inputPath,
                error: 'Absolute paths are not allowed',
            };
        }
    }

    // Normalize the path
    const normalizedPath = normalize(inputPath);

    // Resolve to absolute path for validation
    let resolvedPath: string;
    try {
        // Try to resolve symlinks to get the real path
        if (!normalizedConfig.allowSymlinks) {
            try {
                resolvedPath = await realpath(inputPath);
            } catch {
                // File doesn't exist yet, use normal resolution
                resolvedPath = resolve(normalizedPath);
            }
        } else {
            resolvedPath = resolve(normalizedPath);
        }
    } catch (error) {
        return {
            valid: false,
            resolvedPath: inputPath,
            error: `Failed to resolve path: ${(error as Error).message}`,
        };
    }

    // Check if resolved path is within allowed directories
    for (const allowedDir of allowedDirectories) {
        const resolvedAllowedDir = resolve(allowedDir);
        if (isPathWithin(resolvedPath, resolvedAllowedDir)) {
            return {
                valid: true,
                resolvedPath,
            };
        }
    }

    return {
        valid: false,
        resolvedPath,
        error: `Path is outside allowed directories: ${allowedDirectories.join(', ')}`,
    };
}

/**
 * Checks if a path is allowed within the configured directories
 * Similar to validatePath but returns boolean for quick checks
 */
export async function isPathAllowed(
    inputPath: string,
    config: PathAccessConfig
): Promise<boolean> {
    const result = await validatePath(inputPath, config);
    return result.valid;
}

/**
 * Resolves a path safely, ensuring it stays within allowed directories
 * Returns the resolved path if valid, throws error if not
 */
export async function resolveSafePath(
    inputPath: string,
    config: PathAccessConfig
): Promise<string> {
    const result = await validatePath(inputPath, config);

    if (!result.valid) {
        throw new Error(`Path validation failed: ${result.error}`);
    }

    return result.resolvedPath;
}

/**
 * Resolves a path relative to a base directory and validates it
 */
export async function resolveInDirectory(
    basePath: string,
    relativePath: string,
    config: PathAccessConfig
): Promise<PathValidationResult> {
    const fullPath = resolve(basePath, relativePath);
    return validatePath(fullPath, config);
}

// ============================================================================
// Sandbox-Specific Path Utilities
// ============================================================================

/**
 * Creates a path access configuration for sandbox operations
 */
export function createSandboxPathConfig(
    context: SandboxPathContext
): PathAccessConfig {
    const allowedDirs = [
        context.sandboxDir,
        context.playgroundDir,
        ...(context.allowedDirs || []),
    ];

    return {
        allowedDirectories: allowedDirs,
        allowSymlinks: false,
        allowAbsolutePaths: false,
        maxPathLength: 4096,
    };
}

/**
 * Validates a path is within the sandbox playground
 */
export async function validatePlaygroundPath(
    playgroundDir: string,
    inputPath: string
): Promise<PathValidationResult> {
    return validatePath(inputPath, {
        allowedDirectories: [playgroundDir],
        allowSymlinks: false,
        allowAbsolutePaths: false,
    });
}

/**
 * Validates a path is within the sandbox (.ouroboros directory)
 */
export async function validateSandboxPath(
    sandboxDir: string,
    inputPath: string
): Promise<PathValidationResult> {
    return validatePath(inputPath, {
        allowedDirectories: [sandboxDir],
        allowSymlinks: false,
        allowAbsolutePaths: false,
    });
}

/**
 * Sanitizes a filename to prevent path injection
 * Removes directory separators and special characters
 */
export function sanitizeFilename(filename: string): string {
    return filename
        .replace(/[\/\\]/g, '') // Remove path separators
        .replace(/\.\./g, '') // Remove traversal sequences
        .replace(/\0/g, '') // Remove null bytes
        .replace(/[<>:"|?*]/g, '') // Remove invalid Windows characters
        .slice(0, 255); // Limit length
}

/**
 * Gets the relative path from a base directory
 * Returns null if the path is not within the base directory
 */
export function getRelativePath(basePath: string, targetPath: string): string | null {
    try {
        const resolvedBase = resolve(basePath);
        const resolvedTarget = resolve(targetPath);

        if (!isPathWithin(resolvedTarget, resolvedBase)) {
            return null;
        }

        return relative(resolvedBase, resolvedTarget);
    } catch {
        return null;
    }
}

// ============================================================================
// Security Check Functions
// ============================================================================

/**
 * Checks if a path contains suspicious patterns that may indicate an attack
 */
export function detectSuspiciousPathPatterns(inputPath: string): string[] {
    const suspicious: string[] = [];

    // Check for null byte injection
    if (NULL_BYTE_PATTERN.test(inputPath)) {
        suspicious.push('null_byte_injection');
    }

    // Check for path traversal
    if (PATH_TRAVERSAL_PATTERN.test(inputPath)) {
        suspicious.push('path_traversal');
    }

    // Check for encoded traversal attempts
    if (inputPath.includes('%2e%2e') || inputPath.includes('%2E%2E')) {
        suspicious.push('url_encoded_traversal');
    }

    // Check for absolute path attempts
    if (isAbsolute(inputPath) || WINDOWS_ABSOLUTE_DRIVE_PATTERN.test(inputPath)) {
        suspicious.push('absolute_path');
    }

    // Check for very long paths (potential buffer overflow attempt)
    if (inputPath.length > 4096) {
        suspicious.push('excessive_length');
    }

    return suspicious;
}

/**
 * Performs a comprehensive security audit on a file path
 */
export async function auditPathSecurity(
    inputPath: string,
    config: PathAccessConfig
): Promise<{
    safe: boolean;
    issues: string[];
    validationResult: PathValidationResult;
}> {
    const issues: string[] = [];

    // Check for suspicious patterns
    const suspicious = detectSuspiciousPathPatterns(inputPath);
    if (suspicious.length > 0) {
        issues.push(`Suspicious patterns detected: ${suspicious.join(', ')}`);
    }

    // Validate the path
    const validationResult = await validatePath(inputPath, config);
    if (!validationResult.valid) {
        issues.push(validationResult.error || 'Path validation failed');
    }

    // Check if file exists and verify it's not a symlink to outside
    try {
        const fileStat = await stat(inputPath);
        if (fileStat.isSymbolicLink() && !config.allowSymlinks) {
            issues.push('Symlinks are not allowed');
        }
    } catch {
        // File doesn't exist, which is fine for new files
    }

    return {
        safe: issues.length === 0,
        issues,
        validationResult,
    };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Checks if a target path is within a base directory
 * Uses resolved absolute paths for accurate comparison
 */
function isPathWithin(targetPath: string, basePath: string): boolean {
    const resolvedTarget = resolve(targetPath);
    const resolvedBase = resolve(basePath);

    // Ensure paths end with separator for proper prefix matching
    const normalizedTarget = resolvedTarget.endsWith('/') || resolvedTarget.endsWith('\\')
        ? resolvedTarget
        : resolvedTarget + '/';
    const normalizedBase = resolvedBase.endsWith('/') || resolvedBase.endsWith('\\')
        ? resolvedBase
        : resolvedBase + '/';

    return normalizedTarget.startsWith(normalizedBase);
}

/**
 * Normalizes a list of paths to absolute paths
 */
export function normalizePaths(paths: string[]): string[] {
    return paths.map(p => resolve(p));
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates a sandbox path utilities instance with a specific configuration
 */
export function createSandboxPathUtils(context: SandboxPathContext) {
    const config = createSandboxPathConfig(context);

    return {
        validatePath: (path: string) => validatePath(path, config),
        isPathAllowed: (path: string) => isPathAllowed(path, config),
        resolveSafePath: (path: string) => resolveSafePath(path, config),
        validatePlaygroundPath: (path: string) => validatePlaygroundPath(context.playgroundDir, path),
        validateSandboxPath: (path: string) => validateSandboxPath(context.sandboxDir, path),
        auditPathSecurity: (path: string) => auditPathSecurity(path, config),
        sanitizeFilename,
        getRelativePath,
    };
}

// ============================================================================
// Exports
// ============================================================================

export default {
    validatePath,
    isPathAllowed,
    resolveSafePath,
    resolveInDirectory,
    createSandboxPathConfig,
    validatePlaygroundPath,
    validateSandboxPath,
    sanitizeFilename,
    getRelativePath,
    detectSuspiciousPathPatterns,
    auditPathSecurity,
    createSandboxPathUtils,
};
