# Cloudflare R2 Uploader

A file uploader that somehow works despite being built by someone who clearly has better things to do. It uploads images to Cloudflare R2 and tries really hard not to bankrupt you with overage charges. Built with React because apparently that's what we do now, and Vercel functions because serverless is the future or whatever.

## What This Thing Actually Does

Look, it's a file uploader. You drag an image, it goes to the cloud, you get a URL. The revolutionary part is that it actually tells you how much of your free tier you've burned through before Cloudflare starts asking for your firstborn.

### File Upload (The Basic Stuff)
- Accepts images because that's what everyone uploads anyway
- 10MB limit because nobody needs to upload their 4K vacation photos
- Progress bars that move and make you feel like something important is happening
- Random filenames so your `cat.jpg` becomes `3f2a8b9c-dead-beef-cafe-babedeadbeef.jpg`

### Usage Tracking (The Actually Useful Part)
- Shows you exactly how close you are to paying Cloudflare real money
- Tracks storage, reads, and writes separately because they're all limited differently for some reason
- Blocks uploads at 50% usage because 100% would be expensive and 80% would be stressful
- Monthly reset that may or may not work depending on timezone shenanigans

### UI (It Looks Pretty I Guess)
- Tailwind CSS because writing actual CSS is for people with time
- Smooth animations that serve no functional purpose but feel nice
- Works on mobile because apparently people upload files from phones now
- Dark mode nowhere to be found because I ran out of caring

### Performance (Mostly Not Terrible)
- Cloudflare edge computing for the one person using this from Antarctica
- Vercel functions that cold start exactly when you don't want them to
- GraphQL Analytics API that sometimes works and sometimes doesn't
- Bundle size optimized through the ancient art of not including things

## Architecture (Or: How Many Services Can We Chain Together)

```
Your Browser -> Vercel API -> Cloudflare R2
     |              |
     |              v
     +-----> Cloudflare GraphQL Analytics API
```

Three services to upload a file. This is modern web development.

## Tech Stack (Resume Keyword Bingo)

- Frontend: React 18 (because 17 is so last year), Vite (webpack is dead), Tailwind CSS (utility-first means never having to say you're sorry)
- Backend: Vercel Functions running Node.js in a container somewhere
- Storage: Cloudflare R2 pretending to be Amazon S3
- Analytics: Cloudflare's GraphQL API that may or may not be having a good day
- Deployment: Vercel because clicking deploy is easier than understanding servers

## Prerequisites (Things You Need Before You Can Be Disappointed)

- Node.js 18+ because 16 is deprecated and 20 isn't stable enough
- A Cloudflare account and the patience to navigate their dashboard
- A Vercel account because who hosts things themselves anymore
- Basic understanding that nothing ever works on the first try

## Installation (Good Luck)

### Step 1: Clone This Mess
```bash
git clone https://github.com/yourusername/r2-object-thrower.git
cd r2-object-thrower
npm install
# pray to whatever deity handles dependency resolution
```

### Step 2: Environment Variables (The Fun Part)
Create `.env.local` and fill it with secrets:
```env
# R2 Configuration (Get these from Cloudflare's maze of a dashboard)
R2_ACCESS_KEY=your_r2_access_key
R2_SECRET_KEY=your_r2_secret_key_thats_definitely_not_in_git_right
R2_BUCKET=your_bucket_name
R2_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
R2_REGION=auto
R2_CUSTOM_DOMAIN=cdn.yourdomain.com

# Cloudflare Analytics (For the masochists)
CLOUDFLARE_EMAIL=your_email@example.com
CLOUDFLARE_GLOBAL_API_KEY=your_global_api_key_that_has_way_too_much_power
CLOUDFLARE_ACCOUNT_ID=your_32_character_account_id_not_31_not_33
CLOUDFLARE_BUCKET_NAME=same_as_above_but_again_for_reasons
```

### Step 3: Deploy to Vercel (Cross Your Fingers)
```bash
vercel --prod
# watch it fail because you forgot to set environment variables
# set environment variables in dashboard
# deploy again
# repeat until it works or you give up
```

## Configuration (More Ways to Break Things)

### Cloudflare R2 Setup
1. Navigate Cloudflare's dashboard UI that changes every month
2. Create a bucket with a name you'll immediately forget
3. Generate API tokens with exactly the right permissions (good luck)
4. Set up a custom domain if you hate yourself

### Usage Limits (The Important Part)
The app blocks uploads at 50% of free tier limits because paying for cloud storage is for people with disposable income:

```js
const FREE_PLAN_LIMITS = {
  STORAGE_GB: 10,              // 10GB total storage
  CLASS_A_OPERATIONS: 1_000_000,   // 1M write operations
  CLASS_B_OPERATIONS: 10_000_000,  // 10M read operations
};

const USAGE_THRESHOLD = 0.5; // Block at 50% because 100% costs money
```

## Usage (What You Came Here For)

### Development
```bash
npm run dev
# navigate to localhost:3000
# upload an image
# watch it either work perfectly or fail spectacularly
```

### Production
```bash
npm run build
vercel --prod
# hope your environment variables are right
# they probably aren't
```

## API Documentation (For the Curious)

### Upload Endpoint
```bash
POST /api/upload
# Send a file, get back a URL and some usage stats
# Returns 429 if you're using too much free tier
# Returns 500 if literally anything goes wrong
```

### Usage Endpoint
```bash
GET /api/usage
# Returns current usage or creative fiction if analytics are down
# Probably accurate within 24 hours
```

## Security (Somewhat Questionable)

- File type validation using magic numbers because MIME types lie
- Random UUID filenames because security through obscurity is still security
- Rate limiting that resets when the server restarts
- Input validation that probably has edge cases
- CORS headers that may or may not be configured correctly

## Customization (Make It Your Own Disaster)

Want to support more file types? Add them to the list and hope your validation logic holds up:
```js
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  // "application/pdf", // uncomment if you hate yourself
];
```

Want different usage limits? Change the numbers and pray:
```js
const USAGE_THRESHOLD = 0.8; // live dangerously
```

## Monitoring (Watching Things Break)

The app shows real-time usage that's accurate most of the time. Green bars mean you're fine, yellow means you're getting close, red means you should probably stop uploading cat photos for a while.

Error logs are scattered across:
- Vercel function logs (for upload failures)
- Browser console (for frontend explosions)
- Cloudflare dashboard (for everything else)

## Troubleshooting (When It All Goes Wrong)

**Upload fails immediately:**
- Check your R2 credentials aren't expired
- Verify the bucket exists and you can spell its name
- Make sure your file is actually an image

**Usage tracking returns zeros:**
- Cloudflare's analytics API is having a moment
- Your account ID is probably wrong (common mistake)
- The GraphQL endpoint is down (less common but possible)

**Everything is broken:**
- Clear your browser cache
- Restart the dev server
- Question your life choices
- Try again tomorrow

**CORS errors everywhere:**
- Check your environment variables
- Verify your domain configuration
- Accept that CORS was a mistake

## Contributing (If You're Brave Enough)

1. Fork this repository
2. Create a branch with a reasonable name
3. Make your changes work locally
4. Test on at least two browsers
5. Write a commit message that explains what you actually did
6. Open a pull request and wait

## License

MIT License because who has time to care about copyright. Use it, break it, fix it, sell it, whatever. Just don't blame me when it doesn't work.

## Final Notes

This project exists because I needed to upload files somewhere and didn't want to pay for storage. It works well enough for my needs and maybe yours too. The code could be better, the architecture could be simpler, and the documentation could be more professional. But it's 3 AM and this works, so here we are.

If you use this and it saves you money or time, great. If it breaks your production system, that's between you and your deployment process. If you find bugs, feel free to fix them or just live with them like the rest of us.

The usage tracking relies on Cloudflare's analytics API which is generally reliable but sometimes returns creative interpretations of reality. The 50% safety margin exists for a reason.

Good luck.
