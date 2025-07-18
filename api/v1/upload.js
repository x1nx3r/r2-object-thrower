// api/v1/upload.js
import formidable from "formidable";
import fs from "fs";
import crypto from "crypto";
import {
  ALLOWED_MIME_TYPES,
  validateFile,
  validateFileExtension,
  uploadToR2,
  validateEnvironment,
} from "../utils/uploadHelpers.js";

function authenticateRequest(req) {
  const authHeader = req.headers.authorization;
  const apiKey = req.headers["x-api-key"];

  // Support both Authorization: Bearer <token> and X-API-Key: <token>
  const token = authHeader?.replace("Bearer ", "") || apiKey;

  if (!token) {
    throw new Error("Missing authentication token");
  }

  if (token !== process.env.API_SECRET_TOKEN) {
    throw new Error("Invalid authentication token");
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

  // Set CORS headers for API access
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Key",
  );

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const startTime = Date.now();

  // Set security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  try {
    // Validate environment variables
    validateEnvironment();

    // Handle GET request for server ping
    if (req.method === "GET") {
      try {
        authenticateRequest(req);

        return res.status(200).json({
          success: true,
          message: "Server is running and authentication successful",
          timestamp: new Date().toISOString(),
          server: {
            status: "online",
            version: "1.0.0",
            uptime: process.uptime(),
            environment: process.env.NODE_ENV || "development",
          },
          api: {
            endpoint: "/api/v1/upload",
            supportedMethods: ["GET", "POST"],
            authentication: "Bearer token or X-API-Key header required",
            maxFileSize: "10MB",
            allowedTypes: ALLOWED_MIME_TYPES,
          },
          responseTime: Date.now() - startTime,
        });
      } catch (authError) {
        console.warn(`API ping authentication failed: ${authError.message}`);
        return res.status(401).json({
          error: "Unauthorized",
          message: authError.message,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Only allow POST requests for file upload
    if (req.method !== "POST") {
      return res.status(405).json({
        error: "Method Not Allowed",
        message: "Only GET (ping) and POST (upload) requests are supported",
        supportedMethods: ["GET", "POST"],
      });
    }

    // Authenticate request for upload
    try {
      authenticateRequest(req);
    } catch (authError) {
      console.warn(`API authentication failed: ${authError.message}`);
      return res.status(401).json({
        error: "Unauthorized",
        message: authError.message,
      });
    }

    // Content-Length validation
    const contentLength = parseInt(req.headers["content-length"] || "0");
    if (contentLength > 12 * 1024 * 1024) {
      return res.status(413).json({
        error: "Request too large",
        message: "File size exceeds 12MB limit",
      });
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
      return res.status(400).json({
        error: "No file uploaded",
        message: "Please provide a file in the 'file' field",
      });
    }

    // Basic MIME type check
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      fs.unlinkSync(file.filepath);
      return res.status(400).json({
        error: "Invalid file type",
        message: `Allowed types: ${ALLOWED_MIME_TYPES.join(", ")}`,
      });
    }

    // File validation
    try {
      await validateFile(file);
    } catch (validationError) {
      fs.unlinkSync(file.filepath);
      console.warn(`API file validation failed: ${validationError.message}`);
      return res.status(400).json({
        error: "File validation failed",
        message: validationError.message,
      });
    }

    // File extension validation
    let fileExtension;
    try {
      fileExtension = validateFileExtension(file);
    } catch (extensionError) {
      fs.unlinkSync(file.filepath);
      return res.status(400).json({
        error: "File extension validation failed",
        message: extensionError.message,
      });
    }

    // Generate filename
    const filename = crypto.randomUUID() + "." + fileExtension;

    // Upload to R2
    const publicUrl = await uploadToR2(file, filename, "api");

    // Clean up temp file
    fs.unlinkSync(file.filepath);

    console.log(`API Upload successful: ${filename} (${file.size} bytes)`);

    const isProduction = process.env.NODE_ENV === "production";

    // Return success response
    return res.status(200).json({
      success: true,
      url: publicUrl,
      filename: filename,
      message: "Upload successful",
      file: {
        originalName: file.originalFilename,
        size: file.size,
        type: file.mimetype,
      },
      ...(!isProduction && {
        debug: {
          processingTime: Date.now() - startTime,
          uploadSource: "api",
        },
      }),
    });
  } catch (error) {
    console.error(`API error:`, error);

    // Clean up temp files for upload errors
    if (req.method === "POST") {
      try {
        if (req.files?.file?.[0]?.filepath) {
          fs.unlinkSync(req.files.file[0].filepath);
        }
      } catch (cleanupError) {
        console.error("Cleanup error:", cleanupError);
      }
    }

    return res.status(500).json({
      error: req.method === "GET" ? "Ping failed" : "Upload failed",
      message:
        process.env.NODE_ENV === "production"
          ? "Internal server error"
          : error.message,
      ...(process.env.NODE_ENV === "development" && {
        stack: error.stack,
        debug: {
          method: req.method,
          uploadSource: "api",
        },
      }),
    });
  }
}
