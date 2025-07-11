// api/upload.js

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import formidable from "formidable";
import fs from "fs";
import crypto from "crypto";

/**
 * Initialize S3 Client for Cloudflare R2
 */
const s3 = new S3Client({
  region: process.env.R2_REGION || "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

/**
 * In-memory storage for rate limiting
 */
const rateLimitStore = new Map();

/**
 * File type security configuration
 */
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
];

/**
 * Magic numbers for file type validation
 */
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
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxAttempts = 20;

  const attempts = rateLimitStore.get(ip) || [];
  const recentAttempts = attempts.filter((time) => now - time < windowMs);

  if (recentAttempts.length >= maxAttempts) {
    return false;
  }

  recentAttempts.push(now);
  rateLimitStore.set(ip, recentAttempts);

  // Cleanup old entries occasionally
  if (Math.random() < 0.01) {
    for (const [ip, attempts] of rateLimitStore.entries()) {
      const recentAttempts = attempts.filter((time) => now - time < windowMs);
      if (recentAttempts.length === 0) {
        rateLimitStore.delete(ip);
      } else {
        rateLimitStore.set(ip, recentAttempts);
      }
    }
  }

  return true;
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
  const buffer = fs.readFileSync(file.filepath);
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

  // Scan for suspicious content
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

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  const startTime = Date.now();
  const clientIP = getClientIP(req);
  const origin = req.headers.origin;

  // Set security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  try {
    // Validate environment variables
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
      console.error("Missing environment variables:", missingVars);
      return res.status(500).json({
        error: `Missing required environment variables: ${missingVars.join(", ")}`,
      });
    }

    // Only allow POST requests
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    // Validate origin
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
        retryAfter: 900,
      });
    }

    // Content-Length validation
    const contentLength = parseInt(req.headers["content-length"] || "0");
    if (contentLength > 12 * 1024 * 1024) {
      return res.status(413).json({ error: "Request too large" });
    }

    // Parse form data
    const form = formidable({
      maxFileSize: 10 * 1024 * 1024,
      maxFields: 5,
      maxFieldsSize: 2 * 1024,
      keepExtensions: true,
      allowEmptyFiles: false,
    });

    const [fields, files] = await form.parse(req);

    const file = files.file?.[0];
    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Basic MIME type check
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      fs.unlinkSync(file.filepath);
      return res.status(400).json({ error: "Invalid file type" });
    }

    // File validation
    try {
      await validateFile(file);
    } catch (validationError) {
      fs.unlinkSync(file.filepath);
      console.warn(
        `File validation failed for IP ${clientIP}: ${validationError.message}`,
      );
      return res.status(400).json({ error: validationError.message });
    }

    // USAGE LIMITS BYPASSED - NO CHECKS PERFORMED
    console.log("⚠️  USAGE LIMITS BYPASSED - Upload proceeding without checks");

    // File extension validation
    const fileExtension = file.originalFilename.split(".").pop().toLowerCase();
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

    // Generate filename
    const filename = crypto.randomUUID() + "." + fileExtension;

    // Read file content
    const fileBuffer = fs.readFileSync(file.filepath);

    // Upload to R2
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

    // Clean up temp file
    fs.unlinkSync(file.filepath);

    // Generate public URL
    const publicUrl = `https://${process.env.R2_CUSTOM_DOMAIN}/free-bucket/${filename}`;

    console.log(
      `Upload successful: ${filename} (${file.size} bytes) from IP: ${clientIP}`,
    );

    const isProduction = process.env.NODE_ENV === "production";

    // Return success response
    return res.status(200).json({
      url: publicUrl,
      message: "Upload successful",
      usage: "Usage limits bypassed - monitoring disabled",
      ...(!isProduction && {
        debug: {
          filename,
          fileSize: file.size,
          mimetype: file.mimetype,
          processingTime: Date.now() - startTime,
          usageLimitsEnabled: false,
          note: "Usage monitoring disabled",
        },
      }),
    });
  } catch (error) {
    console.error(`Upload error from IP ${clientIP}:`, error);

    // Clean up temp files
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
      ...(process.env.NODE_ENV === "development" && { stack: error.stack }),
    });
  }
}
