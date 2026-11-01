// Vercel sets VERCEL_PROJECT_PRODUCTION_URL at build and run time, so the
// advertised image URLs name the project's production domain.
export const origin = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : "http://localhost:3000";
