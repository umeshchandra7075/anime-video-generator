import { z } from "zod";

export const registerSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    email: z.string().trim().email().max(255),
    password: z
      .string()
      .min(10, "Password must be at least 10 characters.")
      .max(128)
      .regex(/[a-z]/, "Password must include a lowercase letter.")
      .regex(/[A-Z]/, "Password must include an uppercase letter.")
      .regex(/[0-9]/, "Password must include a number."),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export const verifyEmailSchema = z.object({
  token: z.string().min(10),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email(),
});

export const resetPasswordSchema = z
  .object({
    token: z.string().min(10),
    password: z
      .string()
      .min(10)
      .max(128)
      .regex(/[a-z]/)
      .regex(/[A-Z]/)
      .regex(/[0-9]/),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export const SUPPORTED_LANGUAGES = [
  "Telugu",
  "English",
  "Hindi",
  "Tamil",
  "Kannada",
  "Malayalam",
  "Bengali",
  "Marathi",
  "Gujarati",
  "Spanish",
  "Japanese",
  "Korean",
  "French",
  "German",
] as const;

export const ANIME_STYLES = [
  "Modern Anime",
  "Cinematic Anime",
  "Dark Fantasy",
  "Shonen",
  "Slice of Life",
  "Romantic Anime",
  "Cyberpunk Anime",
  "Historical Anime",
  "Fantasy Anime",
  "Chibi",
  "Studio-style cinematic animation",
] as const;

export const DURATIONS = ["30s", "1m", "3m", "5m", "10m", "custom"] as const;
export const ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
export const VOICE_GENDERS = ["male", "female", "neutral"] as const;
export const VOICE_STYLES = [
  "calm",
  "emotional",
  "dramatic",
  "energetic",
  "narrator",
  "character_dialogue",
] as const;
export const MUSIC_MOODS = [
  "cinematic",
  "emotional",
  "horror",
  "fantasy",
  "action",
  "romantic",
  "mystery",
  "none",
] as const;

export const createProjectSchema = z.object({
  story: z.string().trim().min(20, "Story must be at least 20 characters.").max(20000),
  language: z.enum(SUPPORTED_LANGUAGES),
  animeStyle: z.enum(ANIME_STYLES),
  duration: z.enum(DURATIONS),
  aspectRatio: z.enum(ASPECT_RATIOS),
  voiceGender: z.enum(VOICE_GENDERS),
  voiceStyle: z.enum(VOICE_STYLES),
  subtitlesOn: z.boolean().default(true),
  subtitleLang: z.string().optional(),
  musicMood: z.enum(MUSIC_MOODS).default("none"),
});

export const updateProjectSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  story: z.string().trim().min(20).max(20000).optional(),
});
