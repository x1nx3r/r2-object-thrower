// api/upload.js

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import formidable from "formidable";
import fs from "fs";
import crypto from "crypto";

/**
 * Enhanced error handling with detailed logging
 */
function handleApiError(res, error, statusCode = 500, context = "") {
  console.error(`[UPLOAD ERROR] ${context}:`, {
    name: error.name,
    message: error.message,
    stack: error.stack,
    statusCode,
    timestamp: new Date().toISOString(),
  });

  // Always ensure we return JSON
  res.setHeader("Content-Type", "application/json");

  return res.status(statusCode).json({
    error: error.name || "Server Error",
    message: error.message || "An unexpected error occurred",
    context: context,
    timestamp: new Date().toISOString(),
    ...(process.env.NODE_ENV === "development" && {
      stack: error.stack,
      details: error,
    }),
  });
}

/**
 * Safe S3 client initialization with error handling
 */
function initializeS3Client() {
  try {
    console.log("[S3 INIT] Initializing S3 client...");
    return new S3Client({
      region: process.env.R2_REGION || "auto",
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY,
        secretAccessKey: process.env.R2_SECRET_KEY,
      },
    });
  } catch (error) {
    console.error("[S3 INIT ERROR]:", error);
    throw new Error(`S3 client initialization failed: ${error.message}`);
  }
}

// Initialize S3 client
const s3 = initializeS3Client();

// Cloudflare R2 Free Plan limits
const FREE_PLAN_LIMITS = {
  STORAGE_GB: 10,
  CLASS_A_OPERATIONS: 1_000_000,
  CLASS_B_OPERATIONS: 10_000_000,
};

const USAGE_THRESHOLD = 0.5;

// In-memory storage for rate limiting
const rateLimitStore = new Map();
const uploadAttempts = new Map();

// File type security configuration
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
];

// Magic numbers for file validation
const MAGIC_NUMBERS = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/gif": [0x47, 0x49, 0x46],
  "image/webp": [0x52, 0x49, 0x46, 0x46],
};

function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function isValidOrigin(origin) {
  const allowedOrigins = [
    process.env.ALLOWED_ORIGIN,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
    "http://localhost:3000",
    "https://localhost:3000",
  ].filter(Boolean);

  return !origin || allowedOrigins.includes(origin);
}

function rateLimitCheck(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 20;

  const attempts = rateLimitStore.get(ip) || [];
  const recentAttempts = attempts.filter((time) => now - time < windowMs);

  if (recentAttempts.length >= maxAttempts) {
    return false;
  }

  recentAttempts.push(now);
  rateLimitStore.set(ip, recentAttempts);

  if (Math.random() < 0.01) {
    cleanupRateLimit();
  }

  return true;
}

function cleanupRateLimit() {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;

  for (const [ip, attempts] of rateLimitStore.entries()) {
    const recentAttempts = attempts.filter((time) => now - time < windowMs);
    if (recentAttempts.length === 0) {
      rateLimitStore.delete(ip);
    } else {
      rateLimitStore.set(ip, recentAttempts);
    }
  }
}

function validateFileType(buffer, mimetype) {
  for (const [type, signature] of Object.entries(MAGIC_NUMBERS)) {
    if (
      type === mimetype ||
      (type === "image/jpeg" && mimetype === "image/jpg")
    ) {
      const matches = signature.every((byte, index) => buffer[index] === byte);
      if (matches) return true;
    }
  }
  return false;
}

async function validateFile(file) {
  console.log(
    "[FILE VALIDATION] Starting validation for:",
    file.originalFilename,
  );

  let buffer;
  try {
    buffer = fs.readFileSync(file.filepath);
    console.log(
      "[FILE VALIDATION] File read successfully, size:",
      buffer.length,
    );
  } catch (error) {
    console.error("[FILE VALIDATION] Failed to read file:", error);
    throw new Error(`Failed to read uploaded file: ${error.message}`);
  }

  const firstBytes = buffer.slice(0, 12);

  if (buffer.length === 0) {
    throw new Error("Empty file not allowed");
  }

  if (!validateFileType(firstBytes, file.mimetype)) {
    throw new Error(
      "File type validation failed - file content doesn't match extension",
    );
  }

  if (buffer.length > 10 * 1024 * 1024) {
    throw new Error("File too large");
  }

  const suspicious = [
    "<script",
    "<?php",
    "<%",
    "javascript:",
    "data:text/html",
  ];
  const fileContent = buffer.toString("utf8", 0, Math.min(buffer.length, 1024));
  for (const pattern of suspicious) {
    if (fileContent.toLowerCase().includes(pattern)) {
      throw new Error("Suspicious file content detected");
    }
  }

  console.log("[FILE VALIDATION] All validations passed");
  return true;
}

async function getCurrentUsage() {
  console.log("[USAGE CHECK] Fetching current usage...");

  try {
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.NEXTAUTH_URL || "http://localhost:3000";

    console.log("[USAGE CHECK] Using base URL:", baseUrl);

    const response = await fetch(`${baseUrl}/api/usage`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });

    console.log("[USAGE CHECK] Response status:", response.status);

    if (!response.ok) {
      throw new Error(
        `Usage API error: ${response.status} ${response.statusText}`,
      );
    }

    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      const text = await response.text();
      throw new Error(
        `Usage API returned non-JSON response: ${text.substring(0, 200)}`,
      );
    }

    const data = await response.json();
    console.log("[USAGE CHECK] Usage data retrieved successfully");
    return data.usage;
  } catch (error) {
    console.error("[USAGE CHECK] Error:", error);
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

async function checkUsageLimits(fileSize = 0) {
  console.log("[USAGE LIMITS] Checking usage limits for file size:", fileSize);

  const currentUsage = await getCurrentUsage();

  const projectedStorageBytes =
    (currentUsage.storage.currentBytes || 0) + fileSize;
  const projectedStorageGB = projectedStorageBytes / (1024 * 1024 * 1024);
  const projectedClassA = currentUsage.classA.currentValue + 1;

  const storagePercentage =
    (projectedStorageGB / FREE_PLAN_LIMITS.STORAGE_GB) * 100;
  const classAPercentage =
    (projectedClassA / FREE_PLAN_LIMITS.CLASS_A_OPERATIONS) * 100;
  const classBPercentage = currentUsage.classB.percentage;

  const exceeded = [];
  const threshold = USAGE_THRESHOLD * 100;

  if (storagePercentage > threshold) {
    exceeded.push(`Storage (${storagePercentage.toFixed(1)}%)`);
  }
  if (classAPercentage > threshold) {
    exceeded.push(`Class A Operations (${classAPercentage.toFixed(1)}%)`);
  }
  if (classBPercentage > threshold) {
    exceeded.push(`Class B Operations (${classBPercentage.toFixed(1)}%)`);
  }

  const result = {
    canUpload: exceeded.length === 0,
    exceededLimits: exceeded,
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
    analyticsError: currentUsage.error,
    shouldBlockUploads: currentUsage.shouldBlockUploads,
  };

  console.log("[USAGE LIMITS] Check result:", {
    canUpload: result.canUpload,
    exceeded: result.exceededLimits,
  });
  return result;
}

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  const requestId = crypto.randomUUID().substring(0, 8);
  console.log(`[REQUEST ${requestId}] ==> Upload request started`);

  // Set JSON content type immediately
  res.setHeader("Content-Type", "application/json");

  const startTime = Date.now();
  const clientIP = getClientIP(req);
  const userAgent = req.headers["user-agent"] || "unknown";
  const origin = req.headers.origin;

  console.log(
    `[REQUEST ${requestId}] Client IP: ${clientIP}, Origin: ${origin}`,
  );

  // Set security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  try {
    console.log(`[REQUEST ${requestId}] Validating environment variables...`);

    // Validate required environment variables
    const requiredEnvVars = [
      "R2_ENDPOINT",
      "R2_ACCESS_KEY",
      "R2_SECRET_KEY",
      "R2_BUCKET",
      "R2_CUSTOM_DOMAIN",
    ];
    const missingVars = requiredEnvVars.filter(
      (varName) => !process.env[varName],
    );

    if (missingVars.length > 0) {
      console.error(
        `[REQUEST ${requestId}] Missing environment variables:`,
        missingVars,
      );
      return handleApiError(
        res,
        new Error(
          `Missing required environment variables: ${missingVars.join(", ")}`,
        ),
        500,
        "ENV_VALIDATION",
      );
    }

    console.log(`[REQUEST ${requestId}] Environment variables validated`);

    // Method validation
    if (req.method !== "POST") {
      console.log(`[REQUEST ${requestId}] Invalid method: ${req.method}`);
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    // Origin validation
    if (!isValidOrigin(origin)) {
      console.warn(`[REQUEST ${requestId}] Invalid origin: ${origin}`);
      return res.status(403).json({ error: "Forbidden - Invalid origin" });
    }

    // Rate limiting
    if (!rateLimitCheck(clientIP)) {
      console.warn(
        `[REQUEST ${requestId}] Rate limit exceeded for IP: ${clientIP}`,
      );
      return res.status(429).json({
        error: "Rate limit exceeded",
        message: "Too many upload attempts. Please wait before trying again.",
        retryAfter: 900,
      });
    }

    // Content-Length validation
    const contentLength = parseInt(req.headers["content-length"] || "0");
    if (contentLength > 12 * 1024 * 1024) {
      console.log(
        `[REQUEST ${requestId}] Request too large: ${contentLength} bytes`,
      );
      return res.status(413).json({ error: "Request too large" });
    }

    console.log(`[REQUEST ${requestId}] Starting form parsing...`);

    // Parse form data with enhanced error handling
    let fields, files;
    try {
      const form = formidable({
        maxFileSize: 10 * 1024 * 1024,
        maxFields: 5,
        maxFieldsSize: 2 * 1024,
        keepExtensions: true,
        allowEmptyFiles: false,
      });

      [fields, files] = await form.parse(req);
      console.log(`[REQUEST ${requestId}] Form parsed successfully`);
    } catch (parseError) {
      console.error(`[REQUEST ${requestId}] Form parsing error:`, parseError);
      return handleApiError(
        res,
        new Error(`File parsing failed: ${parseError.message}`),
        400,
        "FORM_PARSING",
      );
    }

    // Extract file
    const file = files.file?.[0];
    if (!file) {
      console.log(`[REQUEST ${requestId}] No file uploaded`);
      return res.status(400).json({ error: "No file uploaded" });
    }

    console.log(`[REQUEST ${requestId}] File received:`, {
      name: file.originalFilename,
      size: file.size,
      mimetype: file.mimetype,
    });

    // MIME type validation
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      console.log(`[REQUEST ${requestId}] Invalid MIME type: ${file.mimetype}`);
      try {
        fs.unlinkSync(file.filepath);
      } catch (cleanupError) {
        console.error(`[REQUEST ${requestId}] Cleanup error:`, cleanupError);
      }
      return res.status(400).json({ error: "Invalid file type" });
    }

    // File validation
    try {
      await validateFile(file);
      console.log(`[REQUEST ${requestId}] File validation passed`);
    } catch (validationError) {
      console.warn(
        `[REQUEST ${requestId}] File validation failed:`,
        validationError.message,
      );
      try {
        fs.unlinkSync(file.filepath);
      } catch (cleanupError) {
        console.error(`[REQUEST ${requestId}] Cleanup error:`, cleanupError);
      }
      return res.status(400).json({ error: validationError.message });
    }

    // Usage limits check
    let usageCheck;
    try {
      usageCheck = await checkUsageLimits(file.size);
      console.log(`[REQUEST ${requestId}] Usage check completed`);
    } catch (usageError) {
      console.error(`[REQUEST ${requestId}] Usage check error:`, usageError);
      try {
        fs.unlinkSync(file.filepath);
      } catch (cleanupError) {
        console.error(`[REQUEST ${requestId}] Cleanup error:`, cleanupError);
      }
      return handleApiError(
        res,
        new Error(`Usage check failed: ${usageError.message}`),
        500,
        "USAGE_CHECK",
      );
    }

    if (!usageCheck.canUpload || usageCheck.shouldBlockUploads) {
      console.log(`[REQUEST ${requestId}] Upload blocked due to usage limits`);
      try {
        fs.unlinkSync(file.filepath);
      } catch (cleanupError) {
        console.error(`[REQUEST ${requestId}] Cleanup error:`, cleanupError);
      }
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

    // File extension validation
    const fileExtension = file.originalFilename.split(".").pop().toLowerCase();
    const validExtensions = {
      "image/jpeg": ["jpg", "jpeg"],
      "image/png": ["png"],
      "image/gif": ["gif"],
      "image/webp": ["webp"],
    };

    if (!validExtensions[file.mimetype]?.includes(fileExtension)) {
      console.log(
        `[REQUEST ${requestId}] File extension doesn't match MIME type`,
      );
      try {
        fs.unlinkSync(file.filepath);
      } catch (cleanupError) {
        console.error(`[REQUEST ${requestId}] Cleanup error:`, cleanupError);
      }
      return res
        .status(400)
        .json({ error: "File extension doesn't match content type" });
    }

    // Generate filename
    const filename = crypto.randomUUID() + "." + fileExtension;
    console.log(`[REQUEST ${requestId}] Generated filename: ${filename}`);

    // Read file for upload
    let fileBuffer;
    try {
      fileBuffer = fs.readFileSync(file.filepath);
      console.log(
        `[REQUEST ${requestId}] File buffer created, size: ${fileBuffer.length}`,
      );
    } catch (readError) {
      console.error(
        `[REQUEST ${requestId}] Failed to read file for upload:`,
        readError,
      );
      try {
        fs.unlinkSync(file.filepath);
      } catch (cleanupError) {
        console.error(`[REQUEST ${requestId}] Cleanup error:`, cleanupError);
      }
      return handleApiError(
        res,
        new Error(`Failed to read file for upload: ${readError.message}`),
        500,
        "FILE_READ",
      );
    }

    // S3 Upload
    console.log(`[REQUEST ${requestId}] Starting S3 upload...`);
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: filename,
          Body: fileBuffer,
          ContentType: file.mimetype,
          Metadata: {
            "upload-ip": clientIP,
            "upload-time": new Date().toISOString(),
            "original-name": file.originalFilename.substring(0, 100),
            "file-size": file.size.toString(),
          },
        }),
      );
      console.log(`[REQUEST ${requestId}] S3 upload successful`);
    } catch (s3Error) {
      console.error(`[REQUEST ${requestId}] S3 upload error:`, s3Error);
      try {
        fs.unlinkSync(file.filepath);
      } catch (cleanupError) {
        console.error(`[REQUEST ${requestId}] Cleanup error:`, cleanupError);
      }
      return handleApiError(
        res,
        new Error(`File upload failed: ${s3Error.message}`),
        500,
        "S3_UPLOAD",
      );
    }

    // Clean up temp file
    try {
      fs.unlinkSync(file.filepath);
      console.log(`[REQUEST ${requestId}] Temp file cleaned up`);
    } catch (cleanupError) {
      console.warn(
        `[REQUEST ${requestId}] Failed to cleanup temp file:`,
        cleanupError,
      );
    }

    // Generate response
    const publicUrl = `https://${process.env.R2_CUSTOM_DOMAIN}/${filename}`;
    console.log(
      `[REQUEST ${requestId}] Upload completed successfully: ${publicUrl}`,
    );

    // Get updated usage (optional)
    let updatedUsage = null;
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      updatedUsage = await getCurrentUsage();
      console.log(`[REQUEST ${requestId}] Updated usage retrieved`);
    } catch (error) {
      console.warn(
        `[REQUEST ${requestId}] Failed to fetch updated usage:`,
        error,
      );
    }

    const isProduction = process.env.NODE_ENV === "production";

    console.log(
      `[REQUEST ${requestId}] <== Upload completed in ${Date.now() - startTime}ms`,
    );

    return res.status(200).json({
      url: publicUrl,
      message: "Upload successful",
      usage: updatedUsage
        ? {
            storage: `${updatedUsage.storage.percentage.toFixed(1)}% (${updatedUsage.storage.currentGB}GB of ${updatedUsage.storage.limit}GB)`,
            classA: `${updatedUsage.classA.percentage.toFixed(1)}% (${updatedUsage.classA.currentValue.toLocaleString()} of ${updatedUsage.classA.limit.toLocaleString()})`,
            classB: `${updatedUsage.classB.percentage.toFixed(1)}% (${updatedUsage.classB.currentValue.toLocaleString()} of ${updatedUsage.classB.limit.toLocaleString()})`,
            lastUpdated: updatedUsage.lastUpdated,
          }
        : usageCheck.usage,
      ...(!isProduction && {
        debug: {
          requestId,
          filename,
          fileSize: file.size,
          mimetype: file.mimetype,
          processingTime: Date.now() - startTime,
          usageCheck: usageCheck,
          analyticsConfigured: !!(
            process.env.CLOUDFLARE_ACCOUNT_ID &&
            process.env.CLOUDFLARE_GLOBAL_API_KEY &&
            process.env.CLOUDFLARE_BUCKET_NAME
          ),
        },
      }),
    });
  } catch (error) {
    console.error(`[REQUEST ${requestId}] Unhandled error:`, {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });

    // Clean up any remaining temporary files
    try {
      if (req.files?.file?.[0]?.filepath) {
        fs.unlinkSync(req.files.file[0].filepath);
      }
    } catch (cleanupError) {
      console.error(
        `[REQUEST ${requestId}] Final cleanup error:`,
        cleanupError,
      );
    }

    return handleApiError(res, error, 500, "UNHANDLED_ERROR");
  }
}
