/ api/upload.js

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import formidable from "formidable";
import fs from "fs";
import crypto from "crypto";

/**
 * Initialize S3 Client for Cloudflare R2
 * R2 is S3-compatible, so we use AWS SDK with custom endpoint
 */
const s3 = new S3Client({
  region: process.env.R2_REGION || "auto",  // R2 uses "auto" region
  endpoint: process.env.R2_ENDPOINT,        // R2 endpoint URL
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,     // R2 Access Key ID
    secretAccessKey: process.env.R2_SECRET_KEY, // R2 Secret Access Key
  },
});

// Cloudflare R2 Free Plan limits - same as usage.js for consistency
const FREE_PLAN_LIMITS = {
  STORAGE_GB: 10,                    // 10GB storage limit
  CLASS_A_OPERATIONS: 1_000_000,     // 1M Class A operations (writes/lists)
  CLASS_B_OPERATIONS: 10_000_000,    // 10M Class B operations (reads)
};

const USAGE_THRESHOLD = 0.5; // 50% - Block uploads when any limit hits this percentage

/**
 * In-memory storage for rate limiting
 * In production, these should be moved to Redis or Cloudflare KV
 * for persistence across serverless function instances
 */
const rateLimitStore = new Map();      // Stores upload attempts per IP
const uploadAttempts = new Map();      // Additional tracking (currently unused)

/**
 * File type security configuration
 * Only allow image files with strict validation
 */
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",    // Some browsers use this instead of image/jpeg
  "image/png",
  "image/gif",
  "image/webp",
];

/**
 * Magic numbers (file signatures) for file type validation
 * These are the first few bytes that identify real file types
 * Prevents users from uploading malicious files with fake extensions
 */
const MAGIC_NUMBERS = {
  "image/jpeg": [0xff, 0xd8, 0xff],           // JPEG files start with these bytes
  "image/png": [0x89, 0x50, 0x4e, 0x47],      // PNG signature
  "image/gif": [0x47, 0x49, 0x46],            // GIF signature "GIF"
  "image/webp": [0x52, 0x49, 0x46, 0x46],     // WebP RIFF header
};

/**
 * Extract client IP address from request headers
 * Handles various proxy configurations (Vercel, Cloudflare, etc.)
 * @param {Object} req - HTTP request object
 * @returns {string} Client IP address
 */
function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || // Most common proxy header
    req.headers["x-real-ip"] ||                              // Alternative proxy header
    req.connection?.remoteAddress ||                         // Direct connection
    req.socket?.remoteAddress ||                             // Alternative direct connection
    "unknown"                                                // Fallback
  );
}

/**
 * Validate request origin for CORS security
 * Prevents unauthorized domains from using our upload API
 * @param {string} origin - Request origin header
 * @returns {boolean} Whether origin is allowed
 */
function isValidOrigin(origin) {
  const allowedOrigins = [
    process.env.ALLOWED_ORIGIN,                                    // Custom allowed origin
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null, // Vercel preview URLs
    "http://localhost:3000",                                       // Local development
    "https://localhost:3000",                                      // Local development with HTTPS
  ].filter(Boolean); // Remove null/undefined values

  // Allow requests with no origin (like direct API calls) or valid origins
  return !origin || allowedOrigins.includes(origin);
}

/**
 * Rate limiting implementation using sliding window
 * Prevents abuse by limiting uploads per IP address
 * @param {string} ip - Client IP address
 * @returns {boolean} Whether request is within rate limits
 */
function rateLimitCheck(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minute sliding window
  const maxAttempts = 20;          // Maximum 20 uploads per IP per window

  // Get existing attempts for this IP
  const attempts = rateLimitStore.get(ip) || [];

  // Filter to only recent attempts within the time window
  const recentAttempts = attempts.filter((time) => now - time < windowMs);

  // Check if limit exceeded
  if (recentAttempts.length >= maxAttempts) {
    return false; // Rate limit exceeded
  }

  // Add current attempt and update storage
  recentAttempts.push(now);
  rateLimitStore.set(ip, recentAttempts);

  // Periodically cleanup old entries (1% chance per request)
  // This prevents memory leaks in long-running instances
  if (Math.random() < 0.01) {
    cleanupRateLimit();
  }

  return true; // Within rate limits
}

/**
 * Cleanup expired rate limit entries
 * Removes old data to prevent memory leaks
 */
function cleanupRateLimit() {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;

  for (const [ip, attempts] of rateLimitStore.entries()) {
    // Filter to only recent attempts
    const recentAttempts = attempts.filter((time) => now - time < windowMs);

    if (recentAttempts.length === 0) {
      // No recent attempts, remove IP entirely
      rateLimitStore.delete(ip);
    } else {
      // Update with filtered attempts
      rateLimitStore.set(ip, recentAttempts);
    }
  }
}

/**
 * Validate file type using magic numbers (file signatures)
 * Prevents malicious files disguised with image extensions
 * @param {Buffer} buffer - File content buffer
 * @param {string} mimetype - Declared MIME type
 * @returns {boolean} Whether file signature matches declared type
 */
function validateFileType(buffer, mimetype) {
  // Check each known file signature
  for (const [type, signature] of Object.entries(MAGIC_NUMBERS)) {
    // Handle both image/jpeg and image/jpg MIME types
    if (
      type === mimetype ||
      (type === "image/jpeg" && mimetype === "image/jpg")
    ) {
      // Check if file starts with expected signature bytes
      const matches = signature.every((byte, index) => buffer[index] === byte);
      if (matches) return true;
    }
  }
  return false; // No matching signature found
}

/**
 * Comprehensive file validation
 * Performs multiple security checks on uploaded files
 * @param {Object} file - Formidable file object
 * @returns {boolean} True if file passes all validations
 * @throws {Error} If validation fails
 */
async function validateFile(file) {
  // Read file content for analysis
  const buffer = fs.readFileSync(file.filepath);
  const firstBytes = buffer.slice(0, 12); // Get first 12 bytes for magic number check

  // 1. Check for empty files
  if (buffer.length === 0) {
    throw new Error("Empty file not allowed");
  }

  // 2. Validate file signature matches declared type
  if (!validateFileType(firstBytes, file.mimetype)) {
    throw new Error(
      "File type validation failed - file content doesn't match extension",
    );
  }

  // 3. Enforce size limit (10MB max)
  if (buffer.length > 10 * 1024 * 1024) {
    throw new Error("File too large");
  }

  // 4. Scan for suspicious content patterns
  // Check first 1KB of file for common malicious patterns
  const suspicious = [
    "<script",      // JavaScript injection
    "<?php",        // PHP code
    "<%",           // ASP/JSP code
    "javascript:",  // JavaScript URLs
    "data:text/html", // HTML data URLs
  ];

  const fileContent = buffer.toString("utf8", 0, Math.min(buffer.length, 1024));
  for (const pattern of suspicious) {
    if (fileContent.toLowerCase().includes(pattern)) {
      throw new Error("Suspicious file content detected");
    }
  }

  return true; // All validations passed
}

/**
 * Fetch current usage data from our analytics API
 * Used to check if upload would exceed limits
 * @returns {Object} Current usage data or conservative fallback
 */
async function getCurrentUsage() {
  try {
    // Determine base URL for API call
    // Handle both local development and Vercel deployment
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.NEXTAUTH_URL || "http://localhost:3000";

    const response = await fetch(`${baseUrl}/api/usage`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15000), // 15 second timeout to prevent hanging
    });

    if (!response.ok) {
      throw new Error(
        `Usage API error: ${response.status} ${response.statusText}`,
      );
    }

    const data = await response.json();
    return data.usage;
  } catch (error) {
    console.error("Error fetching current usage:", error);

    // Return conservative estimates on error to prevent quota overruns
    // Assumes 60% usage to err on the side of caution
    return {
      storage: {
        currentGB: FREE_PLAN_LIMITS.STORAGE_GB * 0.6,
        limit: FREE_PLAN_LIMITS.STORAGE_GB,
        percentage: 60,
        currentBytes: FREE_PLAN_LIMITS.STORAGE_GB * 0.6 * 1024 * 1024 * 1024,
      },
      classA: {
        currentValue: FREE_PLAN_LIMITS.CLASS_A_OPERATIONS * 0.6,
        limit: FREE_PLAN_LIMITS.CLASS_A_OPERATIONS,
        percentage: 60,
      },
      classB: {
        currentValue: FREE_PLAN_LIMITS.CLASS_B_OPERATIONS * 0.6,
        limit: FREE_PLAN_LIMITS.CLASS_B_OPERATIONS,
        percentage: 60,
      },
      error: error.message,
    };
  }
}

/**
 * Check if uploading a file would exceed usage limits
 * Calculates projected usage after upload and compares to thresholds
 * @param {number} fileSize - Size of file to upload in bytes
 * @returns {Object} Usage check results with recommendations
 */
async function checkUsageLimits(fileSize = 0) {
  const currentUsage = await getCurrentUsage();

  // Calculate what usage would be AFTER this upload
  const projectedStorageBytes =
    (currentUsage.storage.currentBytes || 0) + fileSize;
  const projectedStorageGB = projectedStorageBytes / (1024 * 1024 * 1024);
  const projectedClassA = currentUsage.classA.currentValue + 1; // Each upload = 1 Class A operation

  // Convert to percentages for comparison
  const storagePercentage =
    (projectedStorageGB / FREE_PLAN_LIMITS.STORAGE_GB) * 100;
  const classAPercentage =
    (projectedClassA / FREE_PLAN_LIMITS.CLASS_A_OPERATIONS) * 100;
  const classBPercentage = currentUsage.classB.percentage; // No change for reads

  // Check which limits would be exceeded
  const exceeded = [];
  const threshold = USAGE_THRESHOLD * 100; // Convert 0.5 to 50%

  if (storagePercentage > threshold) {
    exceeded.push(`Storage (${storagePercentage.toFixed(1)}%)`);
  }
  if (classAPercentage > threshold) {
    exceeded.push(`Class A Operations (${classAPercentage.toFixed(1)}%)`);
  }
  if (classBPercentage > threshold) {
    exceeded.push(`Class B Operations (${classBPercentage.toFixed(1)}%)`);
  }

  return {
    canUpload: exceeded.length === 0,           // Can upload if no limits exceeded
    exceededLimits: exceeded,                   // List of exceeded limits
    usage: {
      storage: {
        current: currentUsage.storage.percentage,
        currentGB: currentUsage.storage.currentGB,
        projectedGB: projectedStorageGB.toFixed(3),
        projectedPercentage: storagePercentage.toFixed(2),
        limit: FREE_PLAN_LIMITS.STORAGE_GB,
      },
      classA: {
        current: currentUsage.classA.percentage,
        currentValue: currentUsage.classA.currentValue,
        projectedValue: projectedClassA,
        projectedPercentage: classAPercentage.toFixed(2),
        limit: FREE_PLAN_LIMITS.CLASS_A_OPERATIONS,
      },
      classB: {
        current: currentUsage.classB.percentage,
        currentValue: currentUsage.classB.currentValue,
        limit: FREE_PLAN_LIMITS.CLASS_B_OPERATIONS,
      },
    },
    analyticsError: currentUsage.error,         // Any errors from analytics API
    shouldBlockUploads: currentUsage.shouldBlockUploads, // Backend recommendation
  };
}

/**
 * Vercel configuration to disable built-in body parser
 * We use formidable for multipart form parsing instead
 */
export const config = {
  api: {
    bodyParser: false, // Disable default parser for file uploads
  },
};

/**
 * Main upload handler function
 * Processes file uploads with comprehensive security and usage checks
 * @param {Object} req - HTTP request object
 * @param {Object} res - HTTP response object
 */
export default async function handler(req, res) {
  const startTime = Date.now();               // Track processing time
  const clientIP = getClientIP(req);          // Extract client IP
  const userAgent = req.headers["user-agent"] || "unknown"; // User agent for logging
  const origin = req.headers.origin;         // Request origin for CORS

  // Set security headers to prevent various attacks
  res.setHeader("X-Content-Type-Options", "nosniff");              // Prevent MIME sniffing
  res.setHeader("X-Frame-Options", "DENY");                        // Prevent clickjacking
  res.setHeader("X-XSS-Protection", "1; mode=block");              // XSS protection
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin"); // Limit referrer info

  try {
    // ==================== SECURITY VALIDATIONS ====================

    // 1. Only allow POST requests
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    // 2. Validate request origin (CORS protection)
    if (!isValidOrigin(origin)) {
      console.warn(`Invalid origin attempt: ${origin} from IP: ${clientIP}`);
      return res.status(403).json({ error: "Forbidden - Invalid origin" });
    }

    // 3. Rate limiting check
    if (!rateLimitCheck(clientIP)) {
      console.warn(`Rate limit exceeded for IP: ${clientIP}`);
      return res.status(429).json({
        error: "Rate limit exceeded",
        message: "Too many upload attempts. Please wait before trying again.",
        retryAfter: 900, // 15 minutes in seconds
      });
    }

    // 4. Content-Length validation (prevent oversized requests)
    const contentLength = parseInt(req.headers["content-length"] || "0");
    if (contentLength > 12 * 1024 * 1024) { // 12MB allows for multipart overhead
      return res.status(413).json({ error: "Request too large" });
    }

    // ==================== FILE PROCESSING ====================

    // Parse multipart form data with security limits
    const form = formidable({
      maxFileSize: 10 * 1024 * 1024, // 10MB max file size
      maxFields: 5,                   // Limit form fields to prevent DoS
      maxFieldsSize: 2 * 1024,        // 2KB max for non-file fields
      keepExtensions: true,           // Preserve file extensions
      allowEmptyFiles: false,         // Reject empty files
    });

    const [fields, files] = await form.parse(req);

    // Extract uploaded file
    const file = files.file?.[0];
    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // ==================== FILE VALIDATION ====================

    // 1. Basic MIME type check
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      fs.unlinkSync(file.filepath); // Clean up temp file
      return res.status(400).json({ error: "Invalid file type" });
    }

    // 2. Advanced file validation (magic numbers, content scanning)
    try {
      await validateFile(file);
    } catch (validationError) {
      fs.unlinkSync(file.filepath); // Clean up temp file
      console.warn(
        `File validation failed for IP ${clientIP}: ${validationError.message}`,
      );
      return res.status(400).json({ error: validationError.message });
    }

    // ==================== USAGE LIMIT CHECKS ====================

    // Check if upload would exceed R2 usage limits
    const usageCheck = await checkUsageLimits(file.size);

    if (!usageCheck.canUpload || usageCheck.shouldBlockUploads) {
      fs.unlinkSync(file.filepath); // Clean up temp file
      return res.status(429).json({
        error: "Upload blocked due to usage limits",
        message:
          usageCheck.exceededLimits.length > 0
            ? `Cannot upload: approaching limits for ${usageCheck.exceededLimits.join(", ")}`
            : "Upload blocked: usage threshold exceeded",
        usage: {
          storage: `${usageCheck.usage.storage.projectedPercentage}% (${usageCheck.usage.storage.projectedGB}GB of ${usageCheck.usage.storage.limit}GB after upload)`,
          classA: `${usageCheck.usage.classA.projectedPercentage}% (${usageCheck.usage.classA.projectedValue.toLocaleString()} of ${usageCheck.usage.classA.limit.toLocaleString()})`,
          classB: `${usageCheck.usage.classB.current.toFixed(1)}% (${usageCheck.usage.classB.currentValue.toLocaleString()} of ${usageCheck.usage.classB.limit.toLocaleString()})`,
        },
        threshold: `${USAGE_THRESHOLD * 100}%`,
      });
    }

    // ==================== FILE PROCESSING & UPLOAD ====================

    // Generate secure filename
    const fileExtension = file.originalFilename.split(".").pop().toLowerCase();

    // Validate file extension matches MIME type (additional security)
    const validExtensions = {
      "image/jpeg": ["jpg", "jpeg"],
      "image/png": ["png"],
      "image/gif": ["gif"],
      "image/webp": ["webp"],
    };

    if (!validExtensions[file.mimetype]?.includes(fileExtension)) {
      fs.unlinkSync(file.filepath);
      return res
        .status(400)
        .json({ error: "File extension doesn't match content type" });
    }

    // Generate cryptographically secure random filename
    const filename = crypto.randomUUID() + "." + fileExtension;

    // Read file content for upload
    const fileBuffer = fs.readFileSync(file.filepath);

    // Upload to Cloudflare R2 using S3-compatible API
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,    // R2 bucket name
        Key: filename,                    // Object key (filename)
        Body: fileBuffer,                 // File content
        ContentType: file.mimetype,       // Set correct MIME type
        Metadata: {                       // Custom metadata for tracking
          "upload-ip": clientIP,
          "upload-time": new Date().toISOString(),
          "original-name": file.originalFilename.substring(0, 100), // Truncated for safety
          "file-size": file.size.toString(),
        },
      }),
    );

    // Clean up temporary file
    fs.unlinkSync(file.filepath);

    // ==================== RESPONSE GENERATION ====================

    // Construct public URL using custom domain
    const publicUrl = `https://${process.env.R2_CUSTOM_DOMAIN}/${filename}`;

    // Log successful upload for monitoring
    console.log(
      `Upload successful: ${filename} (${file.size} bytes) from IP: ${clientIP}`,
    );

    // Optionally fetch updated usage data for response
    let updatedUsage = null;
    try {
      // Small delay to allow analytics to process the new upload
      await new Promise((resolve) => setTimeout(resolve, 1000));
      updatedUsage = await getCurrentUsage();
    } catch (error) {
      console.warn("Failed to fetch updated usage:", error);
    }

    // Determine if we're in production (affects debug info)
    const isProduction = process.env.NODE_ENV === "production";

    // Return success response
    return res.status(200).json({
      url: publicUrl,
      message: "Upload successful",
      usage: updatedUsage
        ? {
            // Format usage data for display
            storage: `${updatedUsage.storage.percentage.toFixed(1)}% (${updatedUsage.storage.currentGB}GB of ${updatedUsage.storage.limit}GB)`,
            classA: `${updatedUsage.classA.percentage.toFixed(1)}% (${updatedUsage.classA.currentValue.toLocaleString()} of ${updatedUsage.classA.limit.toLocaleString()})`,
            classB: `${updatedUsage.classB.percentage.toFixed(1)}% (${updatedUsage.classB.currentValue.toLocaleString()} of ${updatedUsage.classB.limit.toLocaleString()})`,
            lastUpdated: updatedUsage.lastUpdated,
          }
        : usageCheck.usage, // Fallback to pre-upload usage data
      // Include debug information in development only
      ...(!isProduction && {
        debug: {
          filename,
          fileSize: file.size,
          mimetype: file.mimetype,
          processingTime: Date.now() - startTime,
          usageCheck: usageCheck,
          analyticsConfigured: !!(
            process.env.CLOUDFLARE_ACCOUNT_ID &&
            process.env.CLOUDFLARE_API_TOKEN &&
            process.env.CLOUDFLARE_BUCKET_NAME
          ),
        },
      }),
    });
  } catch (error) {
    // ==================== ERROR HANDLING ====================

    console.error(`Upload error from IP ${clientIP}:`, error);

    // Clean up any remaining temporary files
    try {
      if (req.files?.file?.[0]?.filepath) {
        fs.unlinkSync(req.files.file[0].filepath);
      }
    } catch (cleanupError) {
      console.error("Cleanup error:", cleanupError);
    }

    // Return appropriate error response
    return res.status(500).json({
      error: "Upload failed",
      message:
        process.env.NODE_ENV === "production"
          ? "Internal server error"     // Hide details in production
          : error.message,              // Show details in development
    });
  }
}
