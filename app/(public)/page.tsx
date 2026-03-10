"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Image from "next/image";
import { useSession, signIn } from "next-auth/react";
import { useEffect, Suspense } from "react";
import { useRouter } from "next/navigation";
import { useBranding } from "@/contexts/branding-context";

function LandingPageContent() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const { appName } = useBranding();

  // Get callbackUrl from query params if present
  const searchParams = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const callbackUrl = searchParams.get('callbackUrl') || '/dashboard';
  
  const handleSignIn = () => {
    // Use signIn function to skip the intermediate page
    signIn('cognito', { callbackUrl });
  };

  useEffect(() => {
    // Only redirect to dashboard if truly authenticated
    // Add a small delay to ensure sign-out completes
    if (status === 'authenticated' && session?.user) {
      const timer = setTimeout(() => {
        router.push(callbackUrl);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [session, status, router, callbackUrl]);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <div className="text-lg text-muted-foreground">Loading...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen w-full">
      <Image
        src="/hero-bg.jpg"
        alt="AI Classroom"
        fill
        className="object-cover"
        priority
      />
      <div className="absolute inset-0 bg-black/20" />
      <div className="relative flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md border-0 shadow-2xl bg-white/80 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-center text-3xl font-bold text-[var(--brand-primary)]">
              Welcome to {appName}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-center mb-6 text-muted-foreground">
              Your creative space for building, exploring, and innovating with AI in education.
            </p>
            <Button
              className="w-full bg-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/90 text-white shadow-lg"
              size="lg"
              onClick={handleSignIn}
            >
              Sign In
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <div className="text-lg text-muted-foreground">Loading...</div>
        </div>
      </div>
    }>
      <LandingPageContent />
    </Suspense>
  );
}
