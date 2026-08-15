// Actor filter enums (worldunboxer/rapid-linkedin-scraper input schema).
// Shared by the search form (client) and action validation (server); a
// "use server" module cannot export constants, so they live here.

export const SEARCH_EXPERIENCE_OPTIONS = ["Intern", "Assistant", "Junior", "Mid-Senior", "Director", "Executive"] as const;
export const SEARCH_EMPLOYMENT_OPTIONS = ["Full-time", "Part-time", "Contract", "Temporary", "Volunteer", "Internship", "Other"] as const;
export const SEARCH_ARRANGEMENT_OPTIONS = ["On-site", "Remote", "Hybrid"] as const;
export const SEARCH_POSTED_OPTIONS = ["Past 24 hours", "Past Week", "Past Month", "Any Time"] as const;
