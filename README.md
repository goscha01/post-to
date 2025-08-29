# Google My Business Manager

A monorepo application for managing Google My Business profiles, posts, reviews, and insights.

## Features

- 🔐 Google OAuth Integration
- 🏢 Business Profile Management  
- 📝 Post Creation & Management
- ⭐ Review Management
- 📊 Analytics & Insights
- 🎨 Modern React UI with Tailwind CSS

## Quick Start

### 1. Install Dependencies
```bash
npm install
npm run install:all
```

### 2. Environment Setup
Create `.env` files in both `backend/` and `frontend/` directories with your:
- Supabase credentials
- Google OAuth credentials  
- JWT secret

### 3. Database Setup
Run `supabase/schema.sql` in your Supabase SQL editor.

### 4. Start Development
```bash
npm run dev
```

Frontend: http://localhost:3000
Backend: http://localhost:3001

## Tech Stack

- **Backend**: Node.js, Express, Google APIs, Supabase
- **Frontend**: React 18, Tailwind CSS, React Router
- **Database**: PostgreSQL (Supabase)

## API Endpoints

- `/auth/*` - Google OAuth authentication
- `/api/gmb/*` - Google My Business operations
- `/api/posts/*` - Post management
- `/api/reviews/*` - Review management  
- `/api/insights/*` - Analytics data

## Project Structure

```
├── backend/          # Express API server
├── frontend/         # React application
├── supabase/         # Database schema
└── package.json      # Root configuration
```

For detailed setup instructions, see the inline code comments and environment variable examples.
