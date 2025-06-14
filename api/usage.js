// api/usage.js
const FREE_PLAN_LIMITS = {
  STORAGE_GB: 10,
  CLASS_A_OPERATIONS: 1_000_000,
  CLASS_B_OPERATIONS: 10_000_000,
};

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
    // Return safe fallback data on error
    return {
      storageBytes: 0,
      classAOperations: 0,
      classBOperations: 0,
      error: error.message,
    };
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
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

    return res.status(200).json({
      usage: {
        storage: {
          currentGB: parseFloat(storageGB.toFixed(2)),
          limit: FREE_PLAN_LIMITS.STORAGE_GB,
          percentage: parseFloat(storagePercentage.toFixed(1)),
        },
        classA: {
          currentValue: currentUsage.classAOperations,
          limit: FREE_PLAN_LIMITS.CLASS_A_OPERATIONS,
          percentage: parseFloat(classAPercentage.toFixed(1)),
        },
        classB: {
          currentValue: currentUsage.classBOperations,
          limit: FREE_PLAN_LIMITS.CLASS_B_OPERATIONS,
          percentage: parseFloat(classBPercentage.toFixed(1)),
        },
      },
      debug: {
        workerUrl: process.env.CF_WORKER_URL,
        lastUpdated: currentUsage.lastUpdated,
        month: currentUsage.month,
        rawData: currentUsage,
        hasError: !!currentUsage.error,
        errorMessage: currentUsage.error,
      },
    });
  } catch (error) {
    console.error("Usage API error:", error);
    return res.status(500).json({
      error: "Failed to fetch usage",
      message: error.message,
      debug: {
        workerUrl: process.env.CF_WORKER_URL,
        hasWorkerUrl: !!process.env.CF_WORKER_URL,
      },
    });
  }
}
