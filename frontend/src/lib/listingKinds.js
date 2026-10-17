// Offers the selection pipeline manages. Publicar creates empleo, ETT and becario offers;
// freelance listings are projects, not hiring processes.
export const PIPELINE_LISTING_KINDS = Object.freeze(['empleo', 'ett', 'becario'])

export function isPipelineListing(listing) {
  return PIPELINE_LISTING_KINDS.includes(listing?.kind)
}
