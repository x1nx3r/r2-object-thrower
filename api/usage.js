// api/usage.js

// Cloudflare R2 Free Plan limits - these are the monthly quotas
const FREE_PLAN_LIMITS = {
  STORAGE_GB: 10, // 10GB storage limit
  CLASS_A_OPERATIONS: 1_000_000, // 1M Class A operations (writes/lists)
  CLASS_B_OPERATIONS: 10_000_000, // 10M Class B operations (reads)
};

/**
 * CloudflareAnalytics Class
 * Handles communication with Cloudflare's GraphQL Analytics API
 * Uses Global API Key authentication method for reliable access
 */
class CloudflareAnalytics {
  constructor(email, globalApiKey, accountId) {
    this.email = email; // Cloudflare account email
    this.globalApiKey = globalApiKey; // Global API key for authentication
    this.accountId = accountId; // Cloudflare account ID
    this.endpoint = "https://api.cloudflare.com/client/v4/graphql"; // GraphQL endpoint
  }

  /**
   * Fetches R2 operation usage data for the current month
   * Operations include PUT, GET, LIST, DELETE etc.
   * @param {string} bucketName - R2 bucket name to filter by (optional)
   * @param {number} days - Legacy parameter, not used (kept for compatibility)
   * @returns {Object} GraphQL response data
   */
  async getR2OperationsUsage(bucketName, days = 30) {
    // These variables are defined but not used - left for potential future use
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Calculate first day of current month - this aligns with R2 billing cycle
    const monthStart = new Date();
    monthStart.setDate(1); // Set to 1st day of current month
    monthStart.setHours(0, 0, 0, 0); // Set to midnight for precise start time

    // GraphQL query to fetch R2 operations data
    // Groups operations by actionType and sums the requests
    // NOTE: GraphQL doesn't support // comments inside queries
    const query = `{
      viewer {
        accounts(filter: { accountTag: "${this.accountId}" }) {
          r2OperationsAdaptiveGroups(
            filter: {
              datetime_geq: "${monthStart.toISOString()}"
              ${bucketName ? `, bucketName: "${bucketName}"` : ""}
            }
            limit: 9999
          ) {
            dimensions {
              actionType
            }
            sum {
              requests
            }
          }
        }
      }
    }`;

    return this.executeGraphQLQuery(query);
  }

  /**
   * Fetches R2 storage usage data for the current month
   * Includes object count, payload size, and metadata size
   * @param {string} bucketName - R2 bucket name to filter by (optional)
   * @returns {Object} GraphQL response data
   */
  async getR2StorageUsage(bucketName) {
    // Use first of current month for storage (same as operations for consistency)
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    // GraphQL query to fetch R2 storage data
    // Orders by datetime DESC to get the most recent values first
    // NOTE: GraphQL doesn't support // comments inside queries
    const query = `{
      viewer {
        accounts(filter: { accountTag: "${this.accountId}" }) {
          r2StorageAdaptiveGroups(
            limit: 9999
            filter: {
              datetime_geq: "${monthStart.toISOString()}"
              ${bucketName ? `, bucketName: "${bucketName}"` : ""}
            }
            orderBy: [datetime_DESC]
          ) {
            max {
              objectCount
              uploadCount
              payloadSize
              metadataSize
            }
            dimensions {
              datetime
            }
          }
        }
      }
    }`;

    return this.executeGraphQLQuery(query);
  }

  /**
   * Executes a GraphQL query against Cloudflare's API
   * Uses X-AUTH-EMAIL and X-AUTH-KEY headers for authentication
   * @param {string} query - GraphQL query string
   * @returns {Object} Parsed response data
   * @throws {Error} If request fails or returns errors
   */
  async executeGraphQLQuery(query) {
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          // Global API Key authentication method
          "X-AUTH-EMAIL": this.email,
          "X-AUTH-KEY": this.globalApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      });

      // Check if HTTP request was successful
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `GraphQL request failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      const result = await response.json();

      // Check if GraphQL returned any errors
      if (result.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
      }

      return result.data;
    } catch (error) {
      console.error("GraphQL query failed:", error);
      throw error;
    }
  }

  /**
   * Processes raw operations data from GraphQL response
   * Categorizes operations into Class A (expensive) and Class B (cheap)
   * @param {Object} data - Raw GraphQL response data
   * @returns {Object} Processed operation counts {classA: number, classB: number}
   */
  processOperationsData(data) {
    const accounts = data?.viewer?.accounts;
    if (!accounts || accounts.length === 0) {
      return { classA: 0, classB: 0 };
    }

    const operations = accounts[0].r2OperationsAdaptiveGroups;

    // Class A operations - more expensive, lower limits
    // These are write, delete, and list operations
    const classA = [
      "ListBuckets", // List all buckets
      "PutBucket", // Create bucket
      "ListObjects", // List objects in bucket
      "PutObject", // Upload/write object
      "CopyObject", // Copy object
      "CompleteMultipartUpload", // Finish multipart upload
      "CreateMultipartUpload", // Start multipart upload
      "ListMultipartUploads", // List ongoing multipart uploads
      "UploadPart", // Upload part of multipart
      "UploadPartCopy", // Copy part in multipart
      "ListParts", // List parts of multipart
      "PutBucketEncryption", // Set bucket encryption
      "PutBucketCors", // Set bucket CORS
      "PutBucketLifecycleConfiguration", // Set lifecycle rules
      "DeleteObject", // Delete object
    ];

    // Class B operations - cheaper, higher limits
    // These are read and metadata operations
    const classB = [
      "HeadBucket", // Check if bucket exists
      "HeadObject", // Get object metadata
      "GetObject", // Download/read object
      "UsageSummary", // Get usage statistics
      "GetBucketEncryption", // Get bucket encryption settings
      "GetBucketLocation", // Get bucket location
      "GetBucketCors", // Get bucket CORS settings
      "GetBucketLifecycleConfiguration", // Get lifecycle configuration
    ];

    // Initialize counters
    const operationCounts = {
      classA: 0,
      classB: 0,
    };

    // Process each operation and categorize it
    operations.forEach((op) => {
      const actionType = op.dimensions.actionType;
      const requests = op.sum.requests || 0;

      if (classA.includes(actionType)) {
        operationCounts.classA += requests;
      } else if (classB.includes(actionType)) {
        operationCounts.classB += requests;
      }
      // Note: Unknown operation types are ignored
    });

    return operationCounts;
  }

  /**
   * Processes raw storage data from GraphQL response
   * Extracts the most recent storage metrics
   * @param {Object} data - Raw GraphQL response data
   * @returns {Object} Processed storage data
   */
  processStorageData(data) {
    const accounts = data?.viewer?.accounts;
    if (!accounts || accounts.length === 0) {
      return { totalBytes: 0, objectCount: 0 };
    }

    const storageGroups = accounts[0].r2StorageAdaptiveGroups;

    if (!storageGroups || storageGroups.length === 0) {
      return { totalBytes: 0, objectCount: 0 };
    }

    // Get the most recent data point (ordered by datetime DESC)
    // This gives us the current storage state
    const latestData = storageGroups[0];
    const payloadSize = latestData.max.payloadSize || 0; // Actual file content
    const metadataSize = latestData.max.metadataSize || 0; // Object metadata
    const objectCount = latestData.max.objectCount || 0; // Number of files

    return {
      totalBytes: payloadSize + metadataSize, // Combined storage usage
      objectCount: objectCount,
      payloadSize: payloadSize,
      metadataSize: metadataSize,
      datetime: latestData.dimensions.datetime,
    };
  }
}

/**
 * Main function to get comprehensive R2 usage data
 * Fetches both operations and storage data in parallel
 * @returns {Object} Complete usage data with error handling
 */
async function getR2Usage() {
  try {
    // Load configuration from environment variables
    const email = process.env.CLOUDFLARE_EMAIL;
    const globalApiKey = process.env.CLOUDFLARE_GLOBAL_API_KEY;
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const bucketName = process.env.CLOUDFLARE_BUCKET_NAME;

    // Validate required configuration
    if (!email || !globalApiKey || !accountId) {
      console.warn("Missing Cloudflare configuration");
      return {
        storageBytes: 0,
        classAOperations: 0,
        classBOperations: 0,
        error: "Missing configuration: email, global API key, or account ID",
      };
    }

    console.log(
      "Fetching usage from Cloudflare GraphQL Analytics API (Global API Key method)",
    );

    // Initialize analytics client
    const analytics = new CloudflareAnalytics(email, globalApiKey, accountId);

    // Fetch both operations and storage data simultaneously for better performance
    const [operationsData, storageData] = await Promise.all([
      analytics.getR2OperationsUsage(bucketName), // Current month operations
      analytics.getR2StorageUsage(bucketName), // Current month storage
    ]);

    // Process the raw data into usable format
    const operations = analytics.processOperationsData(operationsData);
    const storage = analytics.processStorageData(storageData);

    console.log("Usage data from Cloudflare Analytics:", {
      operations,
      storage,
    });

    // Format current month for display (YYYY-MM)
    const currentMonth = new Date().toISOString().slice(0, 7);

    // Return structured usage data
    return {
      storageBytes: storage.totalBytes,
      objectCount: storage.objectCount,
      classAOperations: operations.classA,
      classBOperations: operations.classB,
      lastUpdated: new Date().toISOString(),
      period: `Current month (${currentMonth})`,
      storageDetails: {
        payloadSize: storage.payloadSize,
        metadataSize: storage.metadataSize,
        lastDataPoint: storage.datetime,
      },
    };
  } catch (error) {
    console.error("Error fetching usage from Cloudflare Analytics:", error);
    // Return safe fallback data on error to prevent app crashes
    return {
      storageBytes: 0,
      objectCount: 0,
      classAOperations: 0,
      classBOperations: 0,
      error: error.message,
      lastUpdated: new Date().toISOString(),
    };
  }
}

/**
 * Debug function to test Cloudflare authentication
 * Useful for troubleshooting credential issues
 * @returns {Object} Authentication test results
 */
async function testCloudflareAuth() {
  const email = process.env.CLOUDFLARE_EMAIL;
  const globalApiKey = process.env.CLOUDFLARE_GLOBAL_API_KEY;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  if (!email || !globalApiKey || !accountId) {
    return { error: "Missing credentials" };
  }

  try {
    // Simple GraphQL query to test authentication
    // NOTE: GraphQL doesn't support // comments inside queries
    const response = await fetch(
      "https://api.cloudflare.com/client/v4/graphql",
      {
        method: "POST",
        headers: {
          "X-AUTH-EMAIL": email,
          "X-AUTH-KEY": globalApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: `{
            viewer {
              accounts {
                id
                name
              }
            }
          }`,
        }),
      },
    );

    const result = await response.json();

    if (result.errors) {
      return { error: `Auth test failed: ${JSON.stringify(result.errors)}` };
    }

    const accounts = result.data?.viewer?.accounts || [];
    const targetAccount = accounts.find((acc) => acc.id === accountId);

    return {
      success: true,
      accounts: accounts,
      targetAccountFound: !!targetAccount,
      targetAccount: targetAccount,
      accountId: accountId,
    };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * API Route Handler
 * Main entry point for the /api/usage endpoint
 * Supports GET requests and debug mode
 */
export default async function handler(req, res) {
  // Set JSON content type immediately
  res.setHeader("Content-Type", "application/json");

  // Only allow GET requests
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // Debug endpoint: /api/usage?debug=auth
  // Tests authentication without fetching full usage data
  if (req.query.debug === "auth") {
    try {
      const authTest = await testCloudflareAuth();
      return res.status(200).json({ authTest });
    } catch (error) {
      console.error("Auth test error:", error);
      return res.status(500).json({
        error: "Auth test failed",
        message: error.message,
      });
    }
  }

  try {
    // Validate Cloudflare configuration
    const requiredEnvVars = [
      "CLOUDFLARE_EMAIL",
      "CLOUDFLARE_GLOBAL_API_KEY",
      "CLOUDFLARE_ACCOUNT_ID",
    ];

    const missingVars = requiredEnvVars.filter(
      (varName) => !process.env[varName],
    );
    if (missingVars.length > 0) {
      console.warn("Missing Cloudflare configuration:", missingVars);
      return res.status(200).json({
        usage: {
          storage: {
            currentGB: 0,
            currentBytes: 0,
            objectCount: 0,
            limit: FREE_PLAN_LIMITS.STORAGE_GB,
            percentage: 0,
          },
          classA: {
            currentValue: 0,
            limit: FREE_PLAN_LIMITS.CLASS_A_OPERATIONS,
            percentage: 0,
          },
          classB: {
            currentValue: 0,
            limit: FREE_PLAN_LIMITS.CLASS_B_OPERATIONS,
            percentage: 0,
          },
          warnings: [
            `Configuration incomplete: missing ${missingVars.join(", ")}`,
          ],
          shouldBlockUploads: false,
          lastUpdated: new Date().toISOString(),
          period: "Configuration incomplete",
        },
        debug: {
          email: process.env.CLOUDFLARE_EMAIL ? "✓ Set" : "✗ Missing",
          globalApiKey: process.env.CLOUDFLARE_GLOBAL_API_KEY
            ? "✓ Set"
            : "✗ Missing",
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID || "✗ Missing",
          bucketName: process.env.CLOUDFLARE_BUCKET_NAME || "✗ Missing",
          configurationError: `Missing required environment variables: ${missingVars.join(", ")}`,
        },
      });
    }

    // Fetch current usage data
    const currentUsage = await getR2Usage();

    // Convert raw bytes to GB for storage calculation
    const storageGB = currentUsage.storageBytes / (1024 * 1024 * 1024);

    // Calculate percentage usage for each limit
    const storagePercentage = (storageGB / FREE_PLAN_LIMITS.STORAGE_GB) * 100;
    const classAPercentage =
      (currentUsage.classAOperations / FREE_PLAN_LIMITS.CLASS_A_OPERATIONS) *
      100;
    const classBPercentage =
      (currentUsage.classBOperations / FREE_PLAN_LIMITS.CLASS_B_OPERATIONS) *
      100;

    // Define thresholds for warnings and blocking
    const criticalThreshold = 80;
    const blockingThreshold = 50;

    // Generate warnings for high usage
    const warnings = [];
    if (storagePercentage >= criticalThreshold) {
      warnings.push(`Storage usage is at ${storagePercentage.toFixed(1)}%`);
    }
    if (classAPercentage >= criticalThreshold) {
      warnings.push(`Class A operations at ${classAPercentage.toFixed(1)}%`);
    }
    if (classBPercentage >= criticalThreshold) {
      warnings.push(`Class B operations at ${classBPercentage.toFixed(1)}%`);
    }

    // Add configuration warnings if there are errors
    if (currentUsage.error) {
      warnings.push(`Analytics error: ${currentUsage.error}`);
    }

    // Determine if uploads should be blocked
    const shouldBlockUploads =
      storagePercentage >= blockingThreshold ||
      classAPercentage >= blockingThreshold ||
      classBPercentage >= blockingThreshold;

    // Return structured response
    return res.status(200).json({
      usage: {
        storage: {
          currentGB: parseFloat(storageGB.toFixed(3)),
          currentBytes: currentUsage.storageBytes,
          objectCount: currentUsage.objectCount,
          limit: FREE_PLAN_LIMITS.STORAGE_GB,
          percentage: parseFloat(storagePercentage.toFixed(2)),
        },
        classA: {
          currentValue: currentUsage.classAOperations,
          limit: FREE_PLAN_LIMITS.CLASS_A_OPERATIONS,
          percentage: parseFloat(classAPercentage.toFixed(2)),
        },
        classB: {
          currentValue: currentUsage.classBOperations,
          limit: FREE_PLAN_LIMITS.CLASS_B_OPERATIONS,
          percentage: parseFloat(classBPercentage.toFixed(2)),
        },
        warnings: warnings,
        shouldBlockUploads: shouldBlockUploads,
        lastUpdated: currentUsage.lastUpdated,
        period: currentUsage.period,
      },
      debug: {
        email: process.env.CLOUDFLARE_EMAIL ? "✓ Set" : "✗ Missing",
        globalApiKey: process.env.CLOUDFLARE_GLOBAL_API_KEY
          ? "✓ Set"
          : "✗ Missing",
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID || "✗ Missing",
        bucketName: process.env.CLOUDFLARE_BUCKET_NAME || "✗ Missing",
        rawData: currentUsage,
        hasError: !!currentUsage.error,
        errorMessage: currentUsage.error,
        storageDetails: currentUsage.storageDetails,
      },
    });
  } catch (error) {
    console.error("Usage API error:", error);

    // Return structured error response
    return res.status(500).json({
      error: "Failed to fetch usage",
      message: error.message,
      debug: {
        email: process.env.CLOUDFLARE_EMAIL ? "✓ Set" : "✗ Missing",
        globalApiKey: process.env.CLOUDFLARE_GLOBAL_API_KEY
          ? "✓ Set"
          : "✗ Missing",
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID || "✗ Missing",
        bucketName: process.env.CLOUDFLARE_BUCKET_NAME || "✗ Missing",
        errorStack:
          process.env.NODE_ENV === "development" ? error.stack : undefined,
      },
    });
  }
}
