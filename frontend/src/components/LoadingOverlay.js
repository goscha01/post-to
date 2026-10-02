import React from 'react';
import { Loader2 } from 'lucide-react';

// Shared loading overlay for dashboards that refetch on filter changes
// (day range, account switch, etc). Keeps the previously-rendered content
// visible but faded, with a centered spinner, so the user has clear
// feedback that a refetch is in flight even when the previous data is
// still readable underneath.
const LoadingOverlay = ({ show, children, label = 'Loading…', minHeight }) => (
  <div className="relative" style={minHeight ? { minHeight } : undefined}>
    <div className={show ? 'opacity-40 pointer-events-none transition-opacity' : 'transition-opacity'}>
      {children}
    </div>
    {show && (
      <div className="absolute inset-0 flex items-start justify-center pt-8 pointer-events-none">
        <div className="inline-flex items-center gap-2 px-3 py-2 bg-white border border-gray-200 rounded-md shadow-sm text-sm text-gray-700">
          <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
          {label}
        </div>
      </div>
    )}
  </div>
);

export default LoadingOverlay;
