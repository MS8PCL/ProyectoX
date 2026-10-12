// Imported and migrated profiles often carry only fullName/name; showing the email instead
// made those candidates hard to recognise in the pipeline and reports.
export function candidateDisplayName(profile) {
  const parts = [profile?.firstName, profile?.lastName].map((part) => String(part || '').trim()).filter(Boolean)
  if (parts.length) return parts.join(' ')
  return String(profile?.fullName || profile?.name || '').trim()
}
