'use client';

import Image from 'next/image';
import { useBranding } from '@/contexts/branding-context';

export function PageBranding() {
  const { orgName, appName, logoSrc } = useBranding();

  return (
    <div className="flex items-center gap-2 mb-1">
      <Image src={logoSrc} alt="" width={20} height={20} className="opacity-70" />
      <span className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
        {orgName} - {appName}
      </span>
    </div>
  );
}
