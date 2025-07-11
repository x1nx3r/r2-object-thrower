import { useState, useRef, useEffect } from "react";

function App() {
  const [url, setUrl] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [copied, setCopied] = useState(false);
  const [usage, setUsage] = useState(null);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [usageError, setUsageError] = useState(null);
  const fileInputRef = useRef(null);

  // Fetch usage on component mount
  useEffect(() => {
    fetchUsage();
  }, []);

  const fetchUsage = async () => {
    setLoadingUsage(true);
    setUsageError(null);
    try {
      const res = await fetch("/api/usage");

      // Check content type before parsing
      const contentType = res.headers.get("content-type");
      let data;

      if (contentType && contentType.includes("application/json")) {
        data = await res.json();
      } else {
        const textResponse = await res.text();
        console.error("Usage API returned non-JSON:", textResponse);
        throw new Error(
          "Server configuration error: API returned HTML instead of JSON",
        );
      }

      if (res.ok) {
        setUsage(data.usage);
        // Show warning if there are usage warnings
        if (data.usage.warnings && data.usage.warnings.length > 0) {
          console.warn("Usage warnings:", data.usage.warnings);
        }
      } else {
        throw new Error(data.error || "Failed to fetch usage");
      }
    } catch (err) {
      console.error("Failed to fetch usage:", err);
      setUsageError(err.message);
      // Set a fallback usage object to prevent UI breaks
      setUsage({
        storage: { percentage: 0, currentGB: 0, limit: 10 },
        classA: { percentage: 0, currentValue: 0, limit: 1000000 },
        classB: { percentage: 0, currentValue: 0, limit: 10000000 },
      });
    } finally {
      setLoadingUsage(false);
    }
  };

  const getUsageColor = (percentage) => {
    if (percentage >= 50) return "text-red-600 bg-red-100";
    if (percentage >= 40) return "text-orange-600 bg-orange-100";
    if (percentage >= 30) return "text-yellow-600 bg-yellow-100";
    return "text-green-600 bg-green-100";
  };

  const getProgressBarColor = (percentage) => {
    if (percentage >= 50) return "bg-gradient-to-r from-red-400 to-red-600";
    if (percentage >= 40)
      return "bg-gradient-to-r from-orange-400 to-orange-600";
    if (percentage >= 30)
      return "bg-gradient-to-r from-yellow-400 to-yellow-600";
    return "bg-gradient-to-r from-green-400 to-green-600";
  };

  const isUploadBlocked = () => {
    if (!usage) return false;
    return (
      usage.shouldBlockUploads ||
      usage.storage?.percentage >= 50 ||
      usage.classA?.percentage >= 50 ||
      usage.classB?.percentage >= 50
    );
  };

  const handleUpload = async (e) => {
    const file = e.target.files[0];

    // Reset states
    setError(null);
    setUrl(null);
    setUploadProgress(0);

    if (!file) return;

    // Check if uploads are blocked before even starting
    if (isUploadBlocked()) {
      setError(
        "Uploads are currently blocked due to usage limits. Please try again later or contact support.",
      );
      return;
    }

    // File size validation (10MB limit)
    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      setError("File size must be less than 10MB");
      return;
    }

    // File type validation
    const allowedTypes = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/gif",
      "image/webp",
    ];
    if (!allowedTypes.includes(file.type)) {
      setError("Only image files (JPEG, PNG, GIF, WebP) are allowed");
      return;
    }

    setUploading(true);

    // Simulate progress for better UX
    const progressInterval = setInterval(() => {
      setUploadProgress((prev) => {
        if (prev >= 90) {
          clearInterval(progressInterval);
          return prev;
        }
        return prev + Math.random() * 20;
      });
    }, 200);

    try {
      const form = new FormData();
      form.append("file", file);

      const res = await fetch("/api/upload", {
        method: "POST",
        body: form,
      });

      // Check if the response is actually JSON before trying to parse
      const contentType = res.headers.get("content-type");
      let data;

      if (contentType && contentType.includes("application/json")) {
        data = await res.json();
      } else {
        // Server returned non-JSON (likely HTML error page)
        const textResponse = await res.text();
        console.error("Server returned non-JSON response:", textResponse);

        throw new Error(
          `Server error: ${res.status} ${res.statusText}. The server returned an HTML error page instead of JSON. This usually means there's a server configuration issue or the API endpoint is not working properly.`,
        );
      }

      if (!res.ok) {
        if (res.status === 429) {
          // Usage limit reached - format the error message better
          const usageInfo = data.usage
            ? Object.entries(data.usage)
                .map(
                  ([key, value]) =>
                    `• ${key.charAt(0).toUpperCase() + key.slice(1)}: ${value}`,
                )
                .join("\n")
            : "";

          setError(
            `${data.error || "Upload blocked"}\n\n${data.message || ""}\n\n${usageInfo ? `Current usage:\n${usageInfo}` : ""}`.trim(),
          );
        } else {
          throw new Error(data.error || `Upload failed: ${res.statusText}`);
        }
      } else {
        setUrl(data.url);
        setUploadProgress(100);

        // Update usage after successful upload
        // The new API should return updated usage in the response
        if (data.usage) {
          // Parse the usage strings back to percentage numbers for the state
          try {
            const updatedUsage = { ...usage };

            // Extract percentages from the response strings
            if (data.usage.storage) {
              const storageMatch = data.usage.storage.match(/(\d+\.?\d*)%/);
              if (storageMatch) {
                updatedUsage.storage.percentage = parseFloat(storageMatch[1]);
              }
            }
            if (data.usage.classA) {
              const classAMatch = data.usage.classA.match(/(\d+\.?\d*)%/);
              if (classAMatch) {
                updatedUsage.classA.percentage = parseFloat(classAMatch[1]);
              }
            }
            if (data.usage.classB) {
              const classBMatch = data.usage.classB.match(/(\d+\.?\d*)%/);
              if (classBMatch) {
                updatedUsage.classB.percentage = parseFloat(classBMatch[1]);
              }
            }

            setUsage(updatedUsage);
          } catch (parseError) {
            console.warn(
              "Failed to parse usage from upload response:",
              parseError,
            );
          }
        }

        // Refresh usage data after a short delay to ensure analytics have updated
        setTimeout(fetchUsage, 2000);
      }
    } catch (err) {
      console.error("Upload error:", err);

      // More detailed error handling
      if (err.name === "TypeError" && err.message.includes("Failed to fetch")) {
        setError(
          "Network error: Unable to connect to the server. Please check your internet connection and try again.",
        );
      } else if (err.message.includes("JSON.parse")) {
        setError(
          "Server configuration error: The server returned an invalid response. Please check the server logs and environment variables.",
        );
      } else {
        setError(err.message || "Upload failed. Please try again.");
      }

      clearInterval(progressInterval);
      setUploadProgress(0);
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragActive(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const event = { target: { files } };
      handleUpload(event);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const handleDragEnter = (e) => {
    e.preventDefault();
    setDragActive(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setDragActive(false);
  };

  const clearFile = () => {
    setUrl(null);
    setError(null);
    setUploadProgress(0);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy URL:", err);
    }
  };

  const formatLastUpdated = (timestamp) => {
    if (!timestamp) return "";
    try {
      const date = new Date(timestamp);
      return date.toLocaleString();
    } catch {
      return "";
    }
  };

  return (
    <div className="min-h-screen bg-gradient-purple flex items-center justify-center p-5 font-inter">
      <div className="glass rounded-3xl p-12 max-w-2xl w-full shadow-2xl">
        {/* Title */}
        <h1 className="text-4xl md:text-5xl font-bold text-gradient text-center mb-8 tracking-tight">
          ✨ Udin's Pseudo-CDN Service
        </h1>

        {/* Usage Display */}
        {usage && (
          <div className="mb-8 p-6 bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xl">📊</span>
              <h3 className="font-bold text-blue-900">Usage Analytics</h3>
              {usage.period && (
                <span className="text-xs text-gray-500 ml-2">
                  ({usage.period})
                </span>
              )}
              <button
                onClick={fetchUsage}
                disabled={loadingUsage}
                className="ml-auto text-xs px-3 py-1 bg-blue-100 text-blue-700 rounded-full hover:bg-blue-200 transition-colors disabled:opacity-50"
              >
                {loadingUsage ? "⟳" : "↻"} Refresh
              </button>
            </div>

            {/* Last Updated */}
            {usage.lastUpdated && (
              <div className="text-xs text-gray-500 mb-4">
                Last updated: {formatLastUpdated(usage.lastUpdated)}
              </div>
            )}

            {/* Usage Error Warning */}
            {usageError && (
              <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                <div className="flex items-center gap-2">
                  <span className="text-yellow-600">⚠️</span>
                  <span className="text-sm text-yellow-800">
                    Usage data may be outdated: {usageError}
                  </span>
                </div>
              </div>
            )}

            <div className="space-y-4">
              {/* Storage Usage */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-medium text-gray-700">
                    Storage
                    {usage.storage?.objectCount && (
                      <span className="text-xs text-gray-500 ml-1">
                        ({usage.storage.objectCount} files)
                      </span>
                    )}
                  </span>
                  <span
                    className={`text-xs px-2 py-1 rounded-full font-medium ${getUsageColor(usage.storage?.percentage || 0)}`}
                  >
                    {(usage.storage?.percentage || 0).toFixed(1)}%
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-500 ${getProgressBarColor(usage.storage?.percentage || 0)}`}
                    style={{
                      width: `${Math.min(usage.storage?.percentage || 0, 100)}%`,
                    }}
                  />
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {usage.storage?.currentGB || 0} GB of{" "}
                  {usage.storage?.limit || 10} GB used
                  {usage.storage?.currentBytes && (
                    <span className="ml-2">
                      ({(usage.storage.currentBytes / (1024 * 1024)).toFixed(1)}{" "}
                      MB)
                    </span>
                  )}
                </div>
              </div>

              {/* Class A Operations */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-medium text-gray-700">
                    Class A Operations
                    <span className="text-xs text-gray-500 ml-1">
                      (writes/lists)
                    </span>
                  </span>
                  <span
                    className={`text-xs px-2 py-1 rounded-full font-medium ${getUsageColor(usage.classA?.percentage || 0)}`}
                  >
                    {(usage.classA?.percentage || 0).toFixed(1)}%
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-500 ${getProgressBarColor(usage.classA?.percentage || 0)}`}
                    style={{
                      width: `${Math.min(usage.classA?.percentage || 0, 100)}%`,
                    }}
                  />
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {usage.classA?.currentValue?.toLocaleString() || 0} of{" "}
                  {usage.classA?.limit?.toLocaleString() || "1,000,000"}{" "}
                  operations
                </div>
              </div>

              {/* Class B Operations */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-medium text-gray-700">
                    Class B Operations
                    <span className="text-xs text-gray-500 ml-1">(reads)</span>
                  </span>
                  <span
                    className={`text-xs px-2 py-1 rounded-full font-medium ${getUsageColor(usage.classB?.percentage || 0)}`}
                  >
                    {(usage.classB?.percentage || 0).toFixed(1)}%
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-500 ${getProgressBarColor(usage.classB?.percentage || 0)}`}
                    style={{
                      width: `${Math.min(usage.classB?.percentage || 0, 100)}%`,
                    }}
                  />
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {usage.classB?.currentValue?.toLocaleString() || 0} of{" "}
                  {usage.classB?.limit?.toLocaleString() || "10,000,000"}{" "}
                  operations
                </div>
              </div>
            </div>

            {/* Warnings */}
            {usage.warnings && usage.warnings.length > 0 && (
              <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                <div className="flex items-start gap-2">
                  <span className="text-yellow-600 mt-0.5">⚠️</span>
                  <div>
                    <div className="text-sm font-medium text-yellow-800 mb-1">
                      Usage Warnings:
                    </div>
                    <ul className="text-sm text-yellow-700 space-y-1">
                      {usage.warnings.map((warning, index) => (
                        <li key={index}>• {warning}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {/* Blocking Warning */}
            {isUploadBlocked() && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                <div className="flex items-center gap-2">
                  <span className="text-red-600">🚫</span>
                  <span className="text-sm font-medium text-red-800">
                    Uploads are currently blocked due to usage limits
                  </span>
                </div>
              </div>
            )}

            {/* Standard warning for approaching limits */}
            {!isUploadBlocked() &&
              (usage.storage?.percentage >= 40 ||
                usage.classA?.percentage >= 40 ||
                usage.classB?.percentage >= 40) && (
                <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <div className="flex items-center gap-2">
                    <span className="text-yellow-600">⚠️</span>
                    <span className="text-sm font-medium text-yellow-800">
                      Approaching usage limits - uploads will be blocked at 50%
                    </span>
                  </div>
                </div>
              )}
          </div>
        )}

        {/* Loading usage state */}
        {!usage && loadingUsage && (
          <div className="mb-8 p-6 bg-gray-50 border border-gray-200 rounded-2xl">
            <div className="flex items-center gap-2">
              <div className="animate-spin text-xl">⟳</div>
              <span className="text-gray-600">
                Loading usage information from Cloudflare Analytics...
              </span>
            </div>
          </div>
        )}

        {/* Upload Area */}
        <div
          className={`
            border-3 border-dashed rounded-2xl p-16 text-center transition-all duration-300 cursor-pointer mb-8 relative overflow-hidden
            ${
              isUploadBlocked()
                ? "border-red-300 bg-red-50 cursor-not-allowed opacity-60"
                : dragActive
                  ? "border-purple-500 bg-gradient-to-br from-purple-50 to-indigo-50 scale-105 shadow-lg"
                  : uploading
                    ? "border-green-400 bg-green-50 cursor-not-allowed"
                    : "border-gray-300 bg-gray-50 hover:border-purple-400 hover:bg-purple-50 hover:-translate-y-1 hover:shadow-xl"
            }
          `}
          onDrop={isUploadBlocked() ? undefined : handleDrop}
          onDragOver={isUploadBlocked() ? undefined : handleDragOver}
          onDragEnter={isUploadBlocked() ? undefined : handleDragEnter}
          onDragLeave={isUploadBlocked() ? undefined : handleDragLeave}
          onClick={() =>
            !uploading && !isUploadBlocked() && fileInputRef.current?.click()
          }
        >
          {isUploadBlocked() ? (
            <div>
              <div className="text-6xl mb-6">🚫</div>
              <div className="text-xl font-semibold text-red-700 mb-2">
                Uploads Blocked
              </div>
              <div className="text-sm text-red-600">
                Usage limits reached. Please wait for usage to reset.
              </div>
            </div>
          ) : uploading ? (
            <div className="animate-bounce-in">
              <div className="text-6xl mb-6 animate-pulse">⏳</div>
              <div className="text-xl font-semibold text-gray-700 mb-6">
                Uploading your file...
              </div>
              <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden mb-4">
                <div
                  className="h-full bg-gradient-green rounded-full transition-all duration-300 relative overflow-hidden"
                  style={{ width: `${uploadProgress}%` }}
                >
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer" />
                </div>
              </div>
              <div className="text-sm font-semibold text-green-600">
                {Math.round(uploadProgress)}% Complete
              </div>
            </div>
          ) : (
            <div className="transition-all duration-300 hover:scale-105">
              <div className="text-6xl mb-6 transition-transform duration-300 hover:scale-110">
                ☁️
              </div>
              <div className="text-xl font-semibold text-gray-700 mb-2">
                {dragActive
                  ? "Drop your image here!"
                  : "Click or drag to upload"}
              </div>
              <div className="text-sm text-gray-500">
                Supports JPEG, PNG, GIF, WebP • Max 10MB
              </div>
            </div>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          onChange={handleUpload}
          accept="image/*"
          disabled={uploading || isUploadBlocked()}
          className="hidden"
        />

        {/* Error Message */}
        {error && (
          <div className="bg-gradient-to-r from-red-50 to-pink-50 border border-red-200 text-red-700 px-6 py-4 rounded-xl mb-6 animate-slide-in font-medium">
            <div className="flex items-start gap-3">
              <span className="text-xl mt-0.5">❌</span>
              <div>
                <div className="font-semibold mb-1">Upload Failed</div>
                <pre className="text-sm whitespace-pre-wrap text-red-600">
                  {error}
                </pre>
              </div>
            </div>
          </div>
        )}

        {/* Success Message */}
        {url && (
          <div className="bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200 rounded-2xl p-8 animate-bounce-in">
            <div className="flex items-center gap-3 text-green-800 font-bold text-lg mb-6">
              <span className="text-2xl">🎉</span>
              <span>Upload Successful!</span>
            </div>

            {/* Preview */}
            <div className="mb-6 text-center">
              <img
                src={url}
                alt="Uploaded file"
                className="max-w-full max-h-60 rounded-xl shadow-lg border border-gray-200 transition-transform duration-300 hover:scale-105 mx-auto"
                onError={(e) => {
                  e.target.style.display = "none";
                }}
              />
            </div>

            {/* Action Buttons */}
            <div className="flex flex-wrap gap-3 mb-6">
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="flex-1 min-w-fit bg-white text-purple-600 border-2 border-purple-600 px-6 py-3 rounded-lg font-semibold text-sm transition-all duration-200 hover:-translate-y-1 hover:shadow-lg flex items-center justify-center gap-2"
              >
                <span>🔗</span>
                <span>View File</span>
              </a>

              <button
                onClick={copyToClipboard}
                className={`flex-1 min-w-fit px-6 py-3 rounded-lg font-semibold text-sm transition-all duration-200 hover:-translate-y-1 hover:shadow-lg flex items-center justify-center gap-2 text-white ${
                  copied ? "bg-green-500" : "bg-gradient-purple"
                }`}
              >
                <span>{copied ? "✓" : "📋"}</span>
                <span>{copied ? "Copied!" : "Copy URL"}</span>
              </button>

              <button
                onClick={clearFile}
                className="flex-1 min-w-fit bg-gradient-red text-white px-6 py-3 rounded-lg font-semibold text-sm transition-all duration-200 hover:-translate-y-1 hover:shadow-lg flex items-center justify-center gap-2"
              >
                <span>🗑️</span>
                <span>Clear</span>
              </button>
            </div>

            {/* URL Display */}
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 font-mono text-xs text-gray-600 break-all leading-relaxed">
              {url}
            </div>
          </div>
        )}
      </div>

      {/* Copied Feedback */}
      {copied && (
        <div className="fixed top-6 right-6 bg-green-500 text-white px-6 py-3 rounded-lg font-semibold shadow-lg animate-slide-in z-50">
          ✅ URL copied to clipboard!
        </div>
      )}
    </div>
  );
}

export default App;
