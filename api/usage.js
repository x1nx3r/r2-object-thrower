const FREE_PLAN_LIMITS = {
  STORAGE_GB: 10,
  CLASS_A_OPERATIONS: 1_000_000,
  CLASS_B_OPERATIONS: 10_000_000,
};

class CloudflareAnalytics {
  constructor(email, globalApiKey, accountId) {
    this.email = email;
    this.globalApiKey = globalApiKey;
    this.accountId = accountId;
    this.endpoint = "https://api.cloudflare.com/client/v4/graphql";
  }

  async getR2OperationsUsage(bucketName, days = 30) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Use first of current month for operations (like in the example)
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

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

  async getR2StorageUsage(bucketName) {
    // Use first of current month for storage (like in the example)
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

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

  async executeGraphQLQuery(query) {
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "X-AUTH-EMAIL": this.email,
          "X-AUTH-KEY": this.globalApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `GraphQL request failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      const result = await response.json();

      if (result.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
      }

      return result.data;
    } catch (error) {
      console.error("GraphQL query failed:", error);
      throw error;
    }
  }

  processOperationsData(data) {
    const accounts = data?.viewer?.accounts;
    if (!accounts || accounts.length === 0) {
      return { classA: 0, classB: 0 };
    }

    const operations = accounts[0].r2OperationsAdaptiveGroups;

    // Define operation types based on the example
    const classA = [
      "ListBuckets",
      "PutBucket",
      "ListObjects",
      "PutObject",
      "CopyObject",
      "CompleteMultipartUpload",
      "CreateMultipartUpload",
      "ListMultipartUploads",
      "UploadPart",
      "UploadPartCopy",
      "ListParts",
      "PutBucketEncryption",
      "PutBucketCors",
      "PutBucketLifecycleConfiguration",
      "DeleteObject",
    ];

    const classB = [
      "HeadBucket",
      "HeadObject",
      "GetObject",
      "UsageSummary",
      "GetBucketEncryption",
      "GetBucketLocation",
      "GetBucketCors",
      "GetBucketLifecycleConfiguration",
    ];

    const operationCounts = {
      classA: 0,
      classB: 0,
    };

    operations.forEach((op) => {
      const actionType = op.dimensions.actionType;
      const requests = op.sum.requests || 0;

      if (classA.includes(actionType)) {
        operationCounts.classA += requests;
      } else if (classB.includes(actionType)) {
        operationCounts.classB += requests;
      }
    });

    return operationCounts;
  }

  processStorageData(data) {
    const accounts = data?.viewer?.accounts;
    if (!accounts || accounts.length === 0) {
      return { totalBytes: 0, objectCount: 0 };
    }

    const storageGroups = accounts[0].r2StorageAdaptiveGroups;

    if (!storageGroups || storageGroups.length === 0) {
      return { totalBytes: 0, objectCount: 0 };
    }

    // Get the most recent data point (should be the latest/largest values)
    const latestData = storageGroups[0];
    const payloadSize = latestData.max.payloadSize || 0;
    const metadataSize = latestData.max.metadataSize || 0;
    const objectCount = latestData.max.objectCount || 0;

    return {
      totalBytes: payloadSize + metadataSize,
      objectCount: objectCount,
      payloadSize: payloadSize,
      metadataSize: metadataSize,
      datetime: latestData.dimensions.datetime,
    };
  }
}

// Get comprehensive R2 usage from Cloudflare GraphQL Analytics API
async function getR2Usage() {
  try {
    const email = process.env.CLOUDFLARE_EMAIL;
    const globalApiKey = process.env.CLOUDFLARE_GLOBAL_API_KEY;
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const bucketName = process.env.CLOUDFLARE_BUCKET_NAME;

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

    const analytics = new CloudflareAnalytics(email, globalApiKey, accountId);

    // Fetch both operations and storage data in parallel
    const [operationsData, storageData] = await Promise.all([
      analytics.getR2OperationsUsage(bucketName), // Current month for operations
      analytics.getR2StorageUsage(bucketName), // Current month for storage
    ]);

    const operations = analytics.processOperationsData(operationsData);
    const storage = analytics.processStorageData(storageData);

    console.log("Usage data from Cloudflare Analytics:", {
      operations,
      storage,
    });

    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM format

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
    // Return safe fallback data on error
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

// Test function for debugging
async function testCloudflareAuth() {
  const email = process.env.CLOUDFLARE_EMAIL;
  const globalApiKey = process.env.CLOUDFLARE_GLOBAL_API_KEY;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  if (!email || !globalApiKey || !accountId) {
    return { error: "Missing credentials" };
  }

  try {
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

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // Debug endpoint
  if (req.query.debug === "auth") {
    const authTest = await testCloudflareAuth();
    return res.status(200).json({ authTest });
  }

  try {
    const currentUsage = await getR2Usage();

    // Calculate percentages
    const storageGB = currentUsage.storageBytes / (1024 * 1024 * 1024);
    const storagePercentage = (storageGB / FREE_PLAN_LIMITS.STORAGE_GB) * 100;
    const classAPercentage =
      (currentUsage.classAOperations / FREE_PLAN_LIMITS.CLASS_A_OPERATIONS) *
      100;
    const classBPercentage =
      (currentUsage.classBOperations / FREE_PLAN_LIMITS.CLASS_B_OPERATIONS) *
      100;

    // Determine if any limits are approaching critical levels
    const criticalThreshold = 80; // 80% threshold for warnings
    const blockingThreshold = 50; // 50% threshold for blocking uploads

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

    const shouldBlockUploads =
      storagePercentage >= blockingThreshold ||
      classAPercentage >= blockingThreshold ||
      classBPercentage >= blockingThreshold;

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
      },
    });
  }
}
