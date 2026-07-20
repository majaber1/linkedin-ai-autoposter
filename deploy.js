#!/usr/bin/env node

// Railway deployment helper
const fs = require('fs');
const path = require('path');

console.log('📦 LinkedIn AI Autoposter - Railway Deployment');
console.log('='.repeat(50));
console.log();
console.log('✅ Your app is ready to deploy!');
console.log();
console.log('🚀 DEPLOY NOW:');
console.log('   1. Go to: https://railway.app');
console.log('   2. Click "Start New Project"');
console.log('   3. Select "Deploy from GitHub"');
console.log('   4. Connect & select: majaber1/linkedin-ai-autoposter');
console.log('   5. Railway auto-deploys!');
console.log();
console.log('⚙️  THEN SET ENVIRONMENT VARIABLES:');
console.log('   - GITHUB_CLIENT_ID');
console.log('   - GITHUB_CLIENT_SECRET');
console.log('   - GITHUB_REDIRECT_URI (your-app.railway.app/auth/github/callback)');
console.log();
console.log('🎉 You\'ll get a live URL in 2-3 minutes!');
console.log();
