import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import {
  findOrCreateOAuthUser,
  getUserByEmail,
  verifyPassword,
} from "@/lib/memory/store";

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || "missing-google-client-id",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "missing-google-client-secret",
      allowDangerousEmailAccountLinking: true,
    }),
    CredentialsProvider({
      name: "Email",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase();
        const password = credentials?.password ?? "";
        if (!email || !password) return null;

        const user = getUserByEmail(email);
        if (!user || !verifyPassword(password, user.password_hash)) return null;

        return {
          id: user.user_id,
          email: user.email,
          name: user.name || user.email,
          image: user.image || undefined,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, account, profile }) {
      if (account?.provider === "google") {
        const email = user?.email ?? token.email;
        if (email) {
          const dbUser = findOrCreateOAuthUser({
            provider: account.provider,
            providerAccountId: account.providerAccountId,
            email,
            name: user?.name ?? token.name,
            image: user?.image ?? token.picture,
          });
          token.sub = dbUser.user_id;
          token.email = dbUser.email;
          token.name = dbUser.name || profile?.name || dbUser.email;
          token.picture = dbUser.image || token.picture;
        }
      } else if (user?.id) {
        token.sub = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? "";
        session.user.email = token.email ?? session.user.email;
        session.user.name = token.name ?? session.user.name;
        session.user.image = token.picture ?? session.user.image;
      }
      return session;
    },
  },
};
