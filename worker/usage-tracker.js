// worker/usage-tracker.js - Enhanced with auto-reset
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Get current month key
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    // 🆕 Auto-reset function
    async function ensureCurrentMonth() {
      try {
        // Check if we have data for current month
        const currentData = await env.R2_USAGE_TRACKER.get(`usage:${monthKey}`);

        if (!currentData) {
          // This is a new month, initialize fresh data
          const freshData = {
            classAOperations: 0,
            classBOperations: 0,
            lastUpdated: new Date().toISOString(),
            monthCreated: new Date().toISOString(),
          };

          const freshStorage = {
            bytes: 0,
            lastUpdated: new Date().toISOString(),
            monthCreated: new Date().toISOString(),
          };

          await env.R2_USAGE_TRACKER.put(
            `usage:${monthKey}`,
            JSON.stringify(freshData),
          );
          await env.R2_USAGE_TRACKER.put(
            `storage:${monthKey}`,
            JSON.stringify(freshStorage),
          );

          console.log(`Auto-reset for new month: ${monthKey}`);
          return { isNewMonth: true, data: freshData, storage: freshStorage };
        }

        return { isNewMonth: false };
      } catch (error) {
        console.error("Error in ensureCurrentMonth:", error);
        return { isNewMonth: false };
      }
    }

    try {
      if (path === "/health" && request.method === "GET") {
        const monthCheck = await ensureCurrentMonth();
        return new Response(
          JSON.stringify({
            status: "ok",
            timestamp: new Date().toISOString(),
            month: monthKey,
            isNewMonth: monthCheck.isNewMonth,
            version: "1.1.0",
          }),
          {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          },
        );
      } else if (path === "/usage" && request.method === "GET") {
        // Ensure we're working with current month data
        await ensureCurrentMonth();

        // Get current usage - try current month first, then latest
        let usageData = await env.R2_USAGE_TRACKER.get(`usage:${monthKey}`);
        let storageData =
          (await env.R2_USAGE_TRACKER.get(`storage:${monthKey}`)) ||
          (await env.R2_USAGE_TRACKER.get(`storage:latest`));

        const usage = usageData
          ? JSON.parse(usageData)
          : {
              classAOperations: 0,
              classBOperations: 0,
              lastUpdated: new Date().toISOString(),
            };

        const storage = storageData
          ? JSON.parse(storageData)
          : {
              bytes: 0,
              lastUpdated: new Date().toISOString(),
            };

        return new Response(
          JSON.stringify({
            storageBytes: storage.bytes,
            classAOperations: usage.classAOperations,
            classBOperations: usage.classBOperations,
            month: monthKey,
            lastUpdated: usage.lastUpdated,
            storageLastUpdated: storage.lastUpdated,
          }),
          {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          },
        );
      } else if (path === "/increment" && request.method === "POST") {
        // Validate operation type
        const body = await request.json();
        const { operation, fileSize } = body;

        if (!operation || !["classA", "classB"].includes(operation)) {
          return new Response(
            JSON.stringify({
              error: "Invalid operation. Must be 'classA' or 'classB'",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }

        // Validate API key
        const authHeader = request.headers.get("Authorization");
        if (!authHeader || authHeader !== `Bearer ${env.API_SECRET}`) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        // Ensure current month (auto-reset if needed)
        await ensureCurrentMonth();

        // Get current usage
        const usageData = await env.R2_USAGE_TRACKER.get(`usage:${monthKey}`);
        const usage = usageData
          ? JSON.parse(usageData)
          : {
              classAOperations: 0,
              classBOperations: 0,
              lastUpdated: new Date().toISOString(),
            };

        // Increment the appropriate counter
        if (operation === "classA") {
          usage.classAOperations += 1;
        } else if (operation === "classB") {
          usage.classBOperations += 1;
        }

        usage.lastUpdated = new Date().toISOString();

        // Save updated usage
        await env.R2_USAGE_TRACKER.put(
          `usage:${monthKey}`,
          JSON.stringify(usage),
        );

        // Update storage if fileSize provided
        if (fileSize && operation === "classA") {
          const storageData =
            (await env.R2_USAGE_TRACKER.get(`storage:${monthKey}`)) ||
            (await env.R2_USAGE_TRACKER.get(`storage:latest`));
          const storage = storageData
            ? JSON.parse(storageData)
            : { bytes: 0, lastUpdated: new Date().toISOString() };

          storage.bytes += fileSize;
          storage.lastUpdated = new Date().toISOString();

          // Save to both current month and latest
          await env.R2_USAGE_TRACKER.put(
            `storage:${monthKey}`,
            JSON.stringify(storage),
          );
          await env.R2_USAGE_TRACKER.put(
            `storage:latest`,
            JSON.stringify(storage),
          );
        }

        return new Response(
          JSON.stringify({
            success: true,
            usage,
            operation,
            fileSize: fileSize || 0,
            month: monthKey,
          }),
          {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          },
        );
      } else if (path === "/reset" && request.method === "POST") {
        // Manual reset (same as before)
        const authHeader = request.headers.get("Authorization");
        if (!authHeader || authHeader !== `Bearer ${env.API_SECRET}`) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        const resetData = {
          classAOperations: 0,
          classBOperations: 0,
          lastUpdated: new Date().toISOString(),
        };

        const storageResetData = {
          bytes: 0,
          lastUpdated: new Date().toISOString(),
        };

        await env.R2_USAGE_TRACKER.put(
          `usage:${monthKey}`,
          JSON.stringify(resetData),
        );

        await env.R2_USAGE_TRACKER.put(
          `storage:${monthKey}`,
          JSON.stringify(storageResetData),
        );

        await env.R2_USAGE_TRACKER.put(
          `storage:latest`,
          JSON.stringify(storageResetData),
        );

        return new Response(
          JSON.stringify({
            success: true,
            message: "Usage and storage reset",
            month: monthKey,
          }),
          {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          },
        );
      } else {
        return new Response(
          JSON.stringify({
            error: "Not Found",
            availableEndpoints: ["/health", "/usage", "/increment", "/reset"],
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          },
        );
      }
    } catch (error) {
      console.error("Worker error:", error);
      return new Response(
        JSON.stringify({
          error: "Internal Server Error",
          message: error.message,
          timestamp: new Date().toISOString(),
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        },
      );
    }
  },
};
