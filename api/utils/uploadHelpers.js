// utils/uploadHelpers.js
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import crypto from "crypto";

/**
 * Initialize S3 Client for Cloudflare R2
 */
export const s3 = new S3Client({
  region: process.env.R2_REGION || "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

/**
 * File type security configuration
 */
export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
];

/**
 * Magic numbers for file type validation
 */
export const MAGIC_NUMBERS = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/gif": [0x47, 0x49, 0x46],
  "image/webp": [0x52, 0x49, 0x46, 0x46],
};

export function validateFileType(buffer, mimetype) {
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

export async function validateFile(file) {
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

export function validateFileExtension(file) {
  const fileExtension = file.originalFilename.split(".").pop().toLowerCase();
  const validExtensions = {
    "image/jpeg": ["jpg", "jpeg"],
    "image/png": ["png"],
    "image/gif": ["gif"],
    "image/webp": ["webp"],
  };

  if (!validExtensions[file.mimetype]?.includes(fileExtension)) {
    throw new Error("File extension doesn't match content type");
  }

  return fileExtension;
}

export async function uploadToR2(file, filename, clientIP = "api") {
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
        "original-name": file.originalFilename.substring(0, 100),
        "file-size": file.size.toString(),
        "upload-source": clientIP === "api" ? "api" : "web",
      },
    }),
  );

  return `https://${process.env.R2_CUSTOM_DOMAIN}/free-bucket/${filename}`;
}

export function validateEnvironment() {
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
    throw new Error(
      `Missing required environment variables: ${missingVars.join(", ")}`,
    );
  }
}
