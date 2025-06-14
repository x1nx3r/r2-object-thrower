import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import formidable from "formidable";
import fs from "fs";
import crypto from "crypto";

const s3 = new S3Client({
  region: process.env.R2_REGION || "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

// Cloudflare R2 Free Plan Limits
const FREE_PLAN_LIMITS = {
  STORAGE_GB: 10,
  CLASS_A_OPERATIONS: 1_000_000,
  CLASS_B_OPERATIONS: 10_000_000,
};

const USAGE_THRESHOLD = 0.5; // 50%

// Rate limiting storage (in production, use Redis/KV)
const rateLimitStore = new Map();
const uploadAttempts = new Map();

// CSRF token store (in production, use secure session storage)
const csrfTokens = new Map();

// File type validation with magic numbers
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
];

const MAGIC_NUMBERS = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/gif": [0x47, 0x49, 0x46],
  "image/webp": [0x52, 0x49, 0x46, 0x46], // RIFF header for WebP
};

// Security utilities
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
    "http://localhost:3000", // Development
    "https://localhost:3000",
  ].filter(Boolean);

  return !origin || allowedOrigins.includes(origin);
}

function rateLimitCheck(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxAttempts = 20; // 20 uploads per 15 min per IP

  const attempts = rateLimitStore.get(ip) || [];
  const recentAttempts = attempts.filter((time) => now - time < windowMs);

  if (recentAttempts.length >= maxAttempts) {
    return false;
  }

  recentAttempts.push(now);
  rateLimitStore.set(ip, recentAttempts);

  // Cleanup old entries periodically
  if (Math.random() < 0.01) {
    // 1% chance
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
  // Check magic numbers
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
  // Read first few bytes for magic number validation
  const buffer = fs.readFileSync(file.filepath);
  const firstBytes = buffer.slice(0, 12);

  // Check file size
  if (buffer.length === 0) {
    throw new Error("Empty file not allowed");
  }

  // Check magic numbers
  if (!validateFileType(firstBytes, file.mimetype)) {
    throw new Error(
      "File type validation failed - file content doesn't match extension",
    );
  }

  // Additional size validation
  if (buffer.length > 10 * 1024 * 1024) {
    throw new Error("File too large");
  }

  // Check for suspicious patterns (basic)
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

  return true;
}

// Helper function to increment usage counter
async function incrementUsageCounter(operation, fileSize = 0) {
  try {
    const workerUrl = process.env.CF_WORKER_URL;
    const apiSecret = process.env.CF_WORKER_SECRET;

    if (!workerUrl || !apiSecret) {
      console.warn("Worker not configured, skipping usage tracking");
      return { success: false, error: "Worker not configured" };
    }

    const response = await fetch(`${workerUrl}/increment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiSecret}`,
      },
      body: JSON.stringify({
        operation,
        fileSize,
      }),
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Worker API error: ${response.status} ${response.statusText}`,
      );
    }

    const result = await response.json();
    return result;
  } catch (error) {
    console.error("Failed to increment usage counter:", error);
    return { success: false, error: error.message };
  }
}

// Get R2 usage from Cloudflare Worker
async function getR2Usage() {
  try {
    const workerUrl = process.env.CF_WORKER_URL;

    if (!workerUrl) {
      console.warn("No worker URL configured");
      return { storageBytes: 0, classAOperations: 0, classBOperations: 0 };
    }

    const response = await fetch(`${workerUrl}/usage`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      throw new Error(
        `Worker API error: ${response.status} ${response.statusText}`,
      );
    }

    const data = await response.json();

    return {
      storageBytes: data.storageBytes || 0,
      classAOperations: data.classAOperations || 0,
      classBOperations: data.classBOperations || 0,
      lastUpdated: data.lastUpdated,
      month: data.month,
    };
  } catch (error) {
    console.error("Error fetching usage from worker:", error);
    // Return conservative estimates on error to prevent overuse
    return {
      storageBytes: FREE_PLAN_LIMITS.STORAGE_GB * 1024 * 1024 * 1024 * 0.4,
      classAOperations: FREE_PLAN_LIMITS.CLASS_A_OPERATIONS * 0.4,
      classBOperations: FREE_PLAN_LIMITS.CLASS_B_OPERATIONS * 0.4,
      error: error.message,
    };
  }
}

// Check if usage is approaching limits
async function checkUsageLimits(fileSize = 0) {
  const currentUsage = await getR2Usage();

  const projectedStorageBytes = currentUsage.storageBytes + fileSize;
  const projectedClassA = currentUsage.classAOperations + 1;

  const storageUsage =
    projectedStorageBytes / (FREE_PLAN_LIMITS.STORAGE_GB * 1024 * 1024 * 1024);
  const classAUsage = projectedClassA / FREE_PLAN_LIMITS.CLASS_A_OPERATIONS;
  const classBUsage =
    currentUsage.classBOperations / FREE_PLAN_LIMITS.CLASS_B_OPERATIONS;

  const exceeded = [];
  if (storageUsage > USAGE_THRESHOLD) {
    exceeded.push(`Storage (${(storageUsage * 100).toFixed(1)}%)`);
  }
  if (classAUsage > USAGE_THRESHOLD) {
    exceeded.push(`Class A Operations (${(classAUsage * 100).toFixed(1)}%)`);
  }
  if (classBUsage > USAGE_THRESHOLD) {
    exceeded.push(`Class B Operations (${(classBUsage * 100).toFixed(1)}%)`);
  }

  return {
    canUpload: exceeded.length === 0,
    exceededLimits: exceeded,
    usage: {
      storage: {
        current: storageUsage,
        currentGB: (currentUsage.storageBytes / (1024 * 1024 * 1024)).toFixed(
          2,
        ),
        limit: FREE_PLAN_LIMITS.STORAGE_GB,
        projected: (projectedStorageBytes / (1024 * 1024 * 1024)).toFixed(2),
      },
      classA: {
        current: classAUsage,
        currentValue: currentUsage.classAOperations,
        projectedValue: projectedClassA,
        limit: FREE_PLAN_LIMITS.CLASS_A_OPERATIONS,
      },
      classB: {
        current: classBUsage,
        currentValue: currentUsage.classBOperations,
        limit: FREE_PLAN_LIMITS.CLASS_B_OPERATIONS,
      },
    },
    workerError: currentUsage.error,
  };
}

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  const startTime = Date.now();
  const clientIP = getClientIP(req);
  const userAgent = req.headers["user-agent"] || "unknown";
  const origin = req.headers.origin;

  // Security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  try {
    // Method validation
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    // Origin validation
    if (!isValidOrigin(origin)) {
      console.warn(`Invalid origin attempt: ${origin} from IP: ${clientIP}`);
      return res.status(403).json({ error: "Forbidden - Invalid origin" });
    }

    // Rate limiting
    if (!rateLimitCheck(clientIP)) {
      console.warn(`Rate limit exceeded for IP: ${clientIP}`);
      return res.status(429).json({
        error: "Rate limit exceeded",
        message: "Too many upload attempts. Please wait before trying again.",
        retryAfter: 900, // 15 minutes
      });
    }

    // Content-Length validation
    const contentLength = parseInt(req.headers["content-length"] || "0");
    if (contentLength > 12 * 1024 * 1024) {
      // 12MB to account for multipart overhead
      return res.status(413).json({ error: "Request too large" });
    }

    // Parse form data
    const form = formidable({
      maxFileSize: 10 * 1024 * 1024,
      maxFields: 5, // Limit number of fields
      maxFieldsSize: 2 * 1024, // 2KB for non-file fields
      keepExtensions: true,
      allowEmptyFiles: false,
    });

    const [fields, files] = await form.parse(req);

    // File validation
    const file = files.file?.[0];
    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Basic file validation
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      fs.unlinkSync(file.filepath);
      return res.status(400).json({ error: "Invalid file type" });
    }

    // Advanced file validation
    try {
      await validateFile(file);
    } catch (validationError) {
      fs.unlinkSync(file.filepath);
      console.warn(
        `File validation failed for IP ${clientIP}: ${validationError.message}`,
      );
      return res.status(400).json({ error: validationError.message });
    }

    // Check usage limits
    const usageCheck = await checkUsageLimits(file.size);

    if (!usageCheck.canUpload) {
      fs.unlinkSync(file.filepath);
      return res.status(429).json({
        error: "Upload limit reached",
        message: `Cannot upload: approaching limits for ${usageCheck.exceededLimits.join(", ")}`,
        usage: {
          storage: `${(usageCheck.usage.storage.current * 100).toFixed(1)}% (${usageCheck.usage.storage.currentGB}GB of ${usageCheck.usage.storage.limit}GB)`,
          classA: `${(usageCheck.usage.classA.current * 100).toFixed(1)}% (${usageCheck.usage.classA.currentValue.toLocaleString()} of ${usageCheck.usage.classA.limit.toLocaleString()})`,
          classB: `${(usageCheck.usage.classB.current * 100).toFixed(1)}% (${usageCheck.usage.classB.currentValue.toLocaleString()} of ${usageCheck.usage.classB.limit.toLocaleString()})`,
        },
      });
    }

    // Generate secure filename
    const fileExtension = file.originalFilename.split(".").pop().toLowerCase();

    // Validate extension against mimetype
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

    const filename = crypto.randomUUID() + "." + fileExtension;

    // Upload to R2
    const fileBuffer = fs.readFileSync(file.filepath);

    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: filename,
        Body: fileBuffer,
        ContentType: file.mimetype,
        Metadata: {
          "upload-ip": clientIP,
          "upload-time": new Date().toISOString(),
          "original-name": file.originalFilename.substring(0, 100), // Truncate for safety
        },
      }),
    );

    // Track usage
    const trackingResult = await incrementUsageCounter("classA", file.size);

    // Clean up temp file
    fs.unlinkSync(file.filepath);

    // Construct public URL - fix the double bucket issue
    const publicUrl = `https://${process.env.R2_CUSTOM_DOMAIN}/${process.env.R2_BUCKET}/${filename}`;

    // Log successful upload
    console.log(
      `Upload successful: ${filename} (${file.size} bytes) from IP: ${clientIP}`,
    );

    // Return response (remove debug info in production)
    const isProduction = process.env.NODE_ENV === "production";

    return res.status(200).json({
      url: publicUrl,
      usage: {
        storage: `${(usageCheck.usage.storage.current * 100).toFixed(1)}% (${usageCheck.usage.storage.projected}GB of ${usageCheck.usage.storage.limit}GB after upload)`,
        classA: `${((usageCheck.usage.classA.projectedValue / FREE_PLAN_LIMITS.CLASS_A_OPERATIONS) * 100).toFixed(1)}% (${usageCheck.usage.classA.projectedValue.toLocaleString()} of ${usageCheck.usage.classA.limit.toLocaleString()})`,
        classB: `${(usageCheck.usage.classB.current * 100).toFixed(1)}% (${usageCheck.usage.classB.currentValue.toLocaleString()} of ${usageCheck.usage.classB.limit.toLocaleString()})`,
      },
      tracking: {
        success: trackingResult.success !== false,
        operation: "classA",
        fileSize: file.size,
      },
      // Only include debug info in development
      ...(!isProduction && {
        debug: {
          filename,
          fileSize: file.size,
          mimetype: file.mimetype,
          processingTime: Date.now() - startTime,
          workerConfigured: !!(
            process.env.CF_WORKER_URL && process.env.CF_WORKER_SECRET
          ),
        },
      }),
    });
  } catch (error) {
    console.error(`Upload error from IP ${clientIP}:`, error);

    // Clean up any temp files
    try {
      if (req.files?.file?.[0]?.filepath) {
        fs.unlinkSync(req.files.file[0].filepath);
      }
    } catch (cleanupError) {
      console.error("Cleanup error:", cleanupError);
    }

    return res.status(500).json({
      error: "Upload failed",
      message:
        process.env.NODE_ENV === "production"
          ? "Internal server error"
          : error.message,
    });
  }
}
