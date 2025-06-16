# ✨ Cloudflare R2 Uploader

A beautiful, modern file uploader with real-time usage tracking for Cloudflare R2 storage. Built with React, Vite, and Tailwind CSS, featuring automatic usage limits to prevent overages on the free tier. It uses vercel function as a pseudo-backend for the upload functionality and Cloudflare KV to track the usage (CAUTION: the usage tracker is too janky it might not work as intended.)

## 🚀 Features

### 📁 **File Upload**
- ✅ Image format support (JPEG, PNG, GIF, WebP)
- ✅ 10MB file size limit
- ✅ Real-time upload progress
- ✅ Secure random UUID filenames

### 📊 **Usage Tracking**
- ✅ Real-time R2 usage monitoring
- ✅ Storage, Class A, and Class B operation tracking
- ✅ Automatic monthly reset
- ✅ 50% usage threshold protection
- ✅ Visual progress bars with color coding

### 🎨 **Beautiful UI**
- ✅ Modern glassmorphism design
- ✅ Tailwind CSS styling
- ✅ Smooth animations and transitions
- ✅ Responsive mobile-friendly layout
- ✅ Dark gradient backgrounds

### ⚡ **Performance**
- ✅ Cloudflare Workers for edge computing
- ✅ KV storage for fast usage tracking
- ✅ Optimized for Vercel deployment
- ✅ Minimal bundle size

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   React App     │    │  Vercel API     │    │ Cloudflare R2   │
│   (Frontend)    │───▶│   (Backend)     │───▶│   (Storage)     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │
         └───────────────────────┼─────────────────────────────────┐
                                 ▼                                 ▼
                    ┌─────────────────┐              ┌─────────────────┐
                    │ Cloudflare      │              │ Cloudflare KV   │
                    │ Worker          │─────────────▶│ (Usage Data)    │
                    │ (Usage API)     │              │                 │
                    └─────────────────┘              └─────────────────┘
```

## 🛠️ Tech Stack

- **Frontend**: React 18, Vite, Tailwind CSS
- **Backend**: Vercel Functions (Node.js)
- **Storage**: Cloudflare R2
- **CDN**: Cloudflare (custom domain)
- **Usage Tracking**: Cloudflare Workers + KV
- **Deployment**: Vercel + Cloudflare

## 📋 Prerequisites

- Node.js 18+ and npm/pnpm
- Cloudflare account
- Vercel account
- Custom domain (optional but recommended)

## ⚙️ Installation

### 1. Clone and Install
```bash
git clone https://github.com/yourusername/r2-object-thrower.git
cd r2-object-thrower
npm install
```

### 2. Environment Setup
Create `.env.local`:
```env
# R2 Configuration
R2_ACCESS_KEY=your_r2_access_key
R2_SECRET_KEY=your_r2_secret_key
R2_BUCKET=your_bucket_name
R2_ENDPOINT=https://account-id.r2.cloudflarestorage.com/bucket-name
R2_REGION=auto
R2_CUSTOM_DOMAIN=cdn.yourdomain.com

# Cloudflare
CLOUDFLARE_ACCOUNT_ID=your_account_id

# Worker Configuration
CF_WORKER_SECRET=your_worker_api_secret
CF_WORKER_URL=https://r2-usage-tracker.your-subdomain.workers.dev
```

### 3. Deploy Cloudflare Worker
```bash
cd worker
npm install -g wrangler
wrangler login
wrangler kv:namespace create "R2_USAGE_TRACKER"
wrangler deploy
```

### 4. Deploy to Vercel
```bash
vercel --prod
```

## 🔧 Configuration

### Cloudflare R2 Setup
1. Create R2 bucket in Cloudflare dashboard
2. Generate R2 API tokens with read/write permissions
3. Set up custom domain for CDN (optional)

### Worker KV Setup
1. Create KV namespace: `R2_USAGE_TRACKER`
2. Update `worker/wrangler.toml` with namespace ID
3. Set API secret in worker environment

### Usage Limits
Edit limits in `api/upload.js`:
```js
const FREE_PLAN_LIMITS = {
  STORAGE_GB: 10,              // 10GB storage
  CLASS_A_OPERATIONS: 1_000_000,   // 1M Class A ops
  CLASS_B_OPERATIONS: 10_000_000,  // 10M Class B ops
};

const USAGE_THRESHOLD = 0.5; // Block at 50% usage
```

## 🚀 Usage

### Development
```bash
npm run dev
```

### Build
```bash
npm run build
```

### Deploy Worker
```bash
cd worker
wrangler deploy
```

## 📊 API Endpoints

### Upload API (`/api/upload`)
```bash
POST /api/upload
Content-Type: multipart/form-data

# Response
{
  "url": "https://cdn.yourdomain.com/uuid.jpg",
  "usage": {
    "storage": "2.3% (0.23GB of 10GB)",
    "classA": "0.1% (1,000 of 1,000,000)",
    "classB": "0.05% (5,000 of 10,000,000)"
  },
  "tracking": {
    "success": true,
    "operation": "classA",
    "fileSize": 1048576
  }
}
```

### Usage API (`/api/usage`)
```bash
GET /api/usage

# Response
{
  "usage": {
    "storage": {
      "currentGB": 0.23,
      "limit": 10,
      "percentage": 2.3
    },
    "classA": {
      "currentValue": 1000,
      "limit": 1000000,
      "percentage": 0.1
    },
    "classB": {
      "currentValue": 5000,
      "limit": 10000000,
      "percentage": 0.05
    }
  }
}
```

### Worker Endpoints
```bash
# Health check
GET https://worker-url.workers.dev/health

# Get usage
GET https://worker-url.workers.dev/usage

# Increment counter (requires auth)
POST https://worker-url.workers.dev/increment
Authorization: Bearer your-secret
{
  "operation": "classA",
  "fileSize": 1048576
}

# Reset counters (requires auth)
POST https://worker-url.workers.dev/reset
Authorization: Bearer your-secret
```

## 🔒 Security Features

- **Random UUID filenames** - Prevents file enumeration
- **File type validation** - Only allows images
- **Size limits** - 10MB maximum file size
- **Usage limits** - Prevents R2 overage charges
- **API authentication** - Worker endpoints protected
- **CORS headers** - Secure cross-origin requests

## 🎨 Customization

### Styling
- Edit `src/index.css` for custom styles
- Modify Tailwind classes in components
- Update color schemes and animations

### File Types
Add support for more file types in `api/upload.js`:
```js
const allowedTypes = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf", // Add PDF support
  "text/plain"       // Add text files
];
```

### Usage Limits
Adjust thresholds and limits based on your needs:
```js
const USAGE_THRESHOLD = 0.8; // Block at 80% instead of 50%
```

## 📈 Monitoring

### Usage Dashboard
- Real-time usage display in the app
- Color-coded progress bars
- Monthly automatic reset
- Usage warnings at 40%

### Logs
- Vercel function logs for upload operations
- Cloudflare Worker logs for usage tracking
- Console logging for debugging

## 🐛 Troubleshooting

### Common Issues

**Upload fails with 500 error:**
- Check R2 credentials in environment variables
- Verify bucket exists and is accessible
- Check Vercel function logs

**Usage tracking not working:**
- Verify worker is deployed and accessible
- Check worker API secret matches
- Test worker endpoints directly

**CORS errors:**
- Ensure worker has proper CORS headers
- Check domain configuration

### Debug Mode
Enable debug logging:
```js
// In api/upload.js
console.log("Debug info:", {
  workerUrl: process.env.CF_WORKER_URL,
  workerConfigured: !!(process.env.CF_WORKER_URL && process.env.CF_WORKER_SECRET)
});
```

## 📝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Cloudflare R2](https://developers.cloudflare.com/r2/) for excellent object storage
- [Vercel](https://vercel.com/) for seamless deployment
- [Tailwind CSS](https://tailwindcss.com/) for beautiful styling
- [Vite](https://vitejs.dev/) for fast development experience

---

**Star ⭐ this repo if it helped you!**
