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

// Helper function to increment usage counter
async function incrementUsageCounter(operation, fileSize = 0) {
  try {
    const workerUrl = process.env.CF_WORKER_URL;
    const apiSecret = process.env.CF_WORKER_SECRET;

    if (!workerUrl || !apiSecret) {
      console.warn("Worker not configured, skipping usage tracking");
      console.log("Worker URL:", !!workerUrl, "Secret:", !!apiSecret);
      return { success: false, error: "Worker not configured" };
    }

    console.log(`Tracking ${operation} operation with fileSize: ${fileSize}`);

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
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Worker API error: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const result = await response.json();
    console.log("Usage tracking result:", result);
    return result;
  } catch (error) {
    console.error("Failed to increment usage counter:", error);
    // Don't fail the upload if tracking fails
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

    console.log("Fetching usage from worker:", workerUrl);

    const response = await fetch(`${workerUrl}/usage`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Worker API error: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const data = await response.json();
    console.log("Usage data from worker:", data);

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
      storageBytes: FREE_PLAN_LIMITS.STORAGE_GB * 1024 * 1024 * 1024 * 0.4, // 40% assumed usage
      classAOperations: FREE_PLAN_LIMITS.CLASS_A_OPERATIONS * 0.4,
      classBOperations: FREE_PLAN_LIMITS.CLASS_B_OPERATIONS * 0.4,
      error: error.message,
    };
  }
}

// Check if usage is approaching limits
async function checkUsageLimits(fileSize = 0) {
  const currentUsage = await getR2Usage();

  // Calculate projected usage
  const projectedStorageBytes = currentUsage.storageBytes + fileSize;
  const projectedClassA = currentUsage.classAOperations + 1; // One PUT operation

  // Calculate usage percentages
  const storageUsage =
    projectedStorageBytes / (FREE_PLAN_LIMITS.STORAGE_GB * 1024 * 1024 * 1024);
  const classAUsage = projectedClassA / FREE_PLAN_LIMITS.CLASS_A_OPERATIONS;
  const classBUsage =
    currentUsage.classBOperations / FREE_PLAN_LIMITS.CLASS_B_OPERATIONS;

  // Check which limits would be exceeded
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
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const form = formidable({
      maxFileSize: 10 * 1024 * 1024,
      keepExtensions: true,
    });

    const [fields, files] = await form.parse(req);

    const file = files.file?.[0];
    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Validate file type
    const allowedTypes = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/gif",
      "image/webp",
    ];
    if (!allowedTypes.includes(file.mimetype)) {
      fs.unlinkSync(file.filepath);
      return res.status(400).json({ error: "Invalid file type" });
    }

    // Check usage limits before uploading
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
        debug: {
          workerError: usageCheck.workerError,
          workerConfigured: !!(
            process.env.CF_WORKER_URL && process.env.CF_WORKER_SECRET
          ),
        },
      });
    }

    // Upload to R2 with pure random filename
    const fileBuffer = fs.readFileSync(file.filepath);

    // Generate completely random filename with original extension
    const fileExtension = file.originalFilename.split(".").pop().toLowerCase();
    const filename = crypto.randomUUID() + "." + fileExtension;

    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: filename,
        Body: fileBuffer,
        ContentType: file.mimetype,
      }),
    );

    // Track the upload (Class A operation) AFTER successful upload
    const trackingResult = await incrementUsageCounter("classA", file.size);

    // Clean up temp file
    fs.unlinkSync(file.filepath);

    // Construct public URL
    const publicUrl = `https://${process.env.R2_CUSTOM_DOMAIN}/${process.env.R2_BUCKET}/${filename}`;

    return res.status(200).json({
      url: publicUrl,
      usage: {
        storage: `${(usageCheck.usage.storage.current * 100).toFixed(1)}% (${usageCheck.usage.storage.projected}GB of ${usageCheck.usage.storage.limit}GB after upload)`,
        classA: `${((usageCheck.usage.classA.projectedValue / FREE_PLAN_LIMITS.CLASS_A_OPERATIONS) * 100).toFixed(1)}% (${usageCheck.usage.classA.projectedValue.toLocaleString()} of ${usageCheck.usage.classA.limit.toLocaleString()})`,
        classB: `${(usageCheck.usage.classB.current * 100).toFixed(1)}% (${usageCheck.usage.classB.currentValue.toLocaleString()} of ${usageCheck.usage.classB.limit.toLocaleString()})`,
      },
      tracking: {
        success: trackingResult.success !== false,
        error: trackingResult.error || null,
        operation: "classA",
        fileSize: file.size,
      },
      debug: {
        filename,
        originalName: file.originalFilename,
        fileSize: file.size,
        mimetype: file.mimetype,
        workerConfigured: !!(
          process.env.CF_WORKER_URL && process.env.CF_WORKER_SECRET
        ),
        workerUrl: process.env.CF_WORKER_URL,
      },
    });
  } catch (error) {
    console.error("Upload error:", error);
    return res.status(500).json({
      error: "Upload failed",
      message: error.message,
      debug: {
        workerConfigured: !!(
          process.env.CF_WORKER_URL && process.env.CF_WORKER_SECRET
        ),
      },
    });
  }
}
