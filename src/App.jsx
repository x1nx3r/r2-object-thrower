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
  const fileInputRef = useRef(null);

  // Fetch usage on component mount
  useEffect(() => {
    fetchUsage();
  }, []);

  const fetchUsage = async () => {
    setLoadingUsage(true);
    try {
      const res = await fetch("/api/usage");
      if (res.ok) {
        const data = await res.json();
        setUsage(data.usage);
      }
    } catch (err) {
      console.error("Failed to fetch usage:", err);
    } finally {
      setLoadingUsage(false);
    }
  };

  const getUsageColor = (percentage) => {
    if (percentage >= 50) return "text-red-600 bg-red-100";
    if (percentage >= 30) return "text-yellow-600 bg-yellow-100";
    return "text-green-600 bg-green-100";
  };

  const getProgressBarColor = (percentage) => {
    if (percentage >= 50) return "bg-gradient-to-r from-red-400 to-red-600";
    if (percentage >= 30)
      return "bg-gradient-to-r from-yellow-400 to-yellow-600";
    return "bg-gradient-to-r from-green-400 to-green-600";
  };

  const handleUpload = async (e) => {
    const file = e.target.files[0];

    // Reset states
    setError(null);
    setUrl(null);
    setUploadProgress(0);

    if (!file) return;

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

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 429) {
          // Usage limit reached
          setError(
            `Upload blocked: ${data.message}\n\nCurrent usage:\n${Object.entries(
              data.usage || {},
            )
              .map(([key, value]) => `• ${key}: ${value}`)
              .join("\n")}`,
          );
        } else {
          throw new Error(data.error || `Upload failed: ${res.statusText}`);
        }
      } else {
        setUrl(data.url);
        setUploadProgress(100);

        // Update usage after successful upload
        if (data.usage) {
          setUsage(data.usage);
        } else {
          // Refresh usage data
          setTimeout(fetchUsage, 1000);
        }
      }
    } catch (err) {
      console.error("Upload error:", err);
      setError(err.message || "Upload failed. Please try again.");
      clearInterval(progressInterval);
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

  return (
    <div className="min-h-screen bg-gradient-purple flex items-center justify-center p-5 font-inter">
      <div className="glass rounded-3xl p-12 max-w-2xl w-full shadow-2xl">
        {/* Title */}
        <h1 className="text-4xl md:text-5xl font-bold text-gradient text-center mb-8 tracking-tight">
          ✨ Cloudflare R2 Uploader
        </h1>

        {/* Usage Display */}
        {usage && (
          <div className="mb-8 p-6 bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xl">📊</span>
              <h3 className="font-bold text-blue-900">Current Usage</h3>
              <button
                onClick={fetchUsage}
                disabled={loadingUsage}
                className="ml-auto text-xs px-3 py-1 bg-blue-100 text-blue-700 rounded-full hover:bg-blue-200 transition-colors disabled:opacity-50"
              >
                {loadingUsage ? "⟳" : "↻"} Refresh
              </button>
            </div>

            <div className="space-y-4">
              {/* Storage Usage */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-medium text-gray-700">
                    Storage
                  </span>
                  <span
                    className={`text-xs px-2 py-1 rounded-full font-medium ${getUsageColor(usage.storage?.percentage || 0)}`}
                  >
                    {usage.storage?.percentage?.toFixed(1) || 0}%
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
                </div>
              </div>

              {/* Class A Operations */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-medium text-gray-700">
                    Class A Operations
                  </span>
                  <span
                    className={`text-xs px-2 py-1 rounded-full font-medium ${getUsageColor(usage.classA?.percentage || 0)}`}
                  >
                    {usage.classA?.percentage?.toFixed(1) || 0}%
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
                  </span>
                  <span
                    className={`text-xs px-2 py-1 rounded-full font-medium ${getUsageColor(usage.classB?.percentage || 0)}`}
                  >
                    {usage.classB?.percentage?.toFixed(1) || 0}%
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

            {/* Warning if approaching limits */}
            {(usage.storage?.percentage >= 40 ||
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
                Loading usage information...
              </span>
            </div>
          </div>
        )}

        {/* Upload Area */}
        <div
          className={`
            border-3 border-dashed rounded-2xl p-16 text-center transition-all duration-300 cursor-pointer mb-8 relative overflow-hidden
            ${
              dragActive
                ? "border-purple-500 bg-gradient-to-br from-purple-50 to-indigo-50 scale-105 shadow-lg"
                : uploading
                  ? "border-green-400 bg-green-50 cursor-not-allowed"
                  : "border-gray-300 bg-gray-50 hover:border-purple-400 hover:bg-purple-50 hover:-translate-y-1 hover:shadow-xl"
            }
          `}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onClick={() => !uploading && fileInputRef.current?.click()}
        >
          {uploading ? (
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
          disabled={uploading}
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
