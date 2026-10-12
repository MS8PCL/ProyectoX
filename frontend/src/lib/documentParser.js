import * as pdfjsLib from 'pdfjs-dist'
import mammoth from 'mammoth'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// Package the matching worker so document parsing also works without external services.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export async function parsePDF(file) {
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  let fullText = ''
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    const text = content.items.map(item => item.str).join(' ')
    fullText += text + '\n'
  }
  return fullText.trim()
}

export async function parseDOCX(file) {
  const arrayBuffer = await file.arrayBuffer()
  const result = await mammoth.extractRawText({ arrayBuffer })
  return result.value.trim()
}

export async function parseDocument(file) {
  const name = file.name.toLowerCase()
  if (name.endsWith('.pdf')) return parsePDF(file)
  if (name.endsWith('.docx') || name.endsWith('.doc')) return parseDOCX(file)
  throw new Error('Formato no soportado. Usá PDF o DOCX.')
}

// Extraer posibles skills del texto
export function extractSkills(text) {
  const commonSkills = [
    'JavaScript', 'TypeScript', 'Python', 'Java', 'C#', 'Go', 'Rust', 'Ruby', 'PHP', 'Swift', 'Kotlin',
    'React', 'Vue', 'Angular', 'Svelte', 'Next.js', 'Nuxt', 'Node.js', 'Express', 'Django', 'Flask', 'FastAPI', 'Spring',
    'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Terraform', 'CI/CD', 'Jenkins', 'GitHub Actions',
    'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'GraphQL', 'REST', 'gRPC',
    'Figma', 'Sketch', 'Adobe XD', 'UI/UX', 'Design Systems',
    'Agile', 'Scrum', 'Kanban', 'JIRA', 'Confluence', 'Product Management',
    'HTML', 'CSS', 'SASS', 'Tailwind', 'Bootstrap',
  ]
  const found = commonSkills.filter(skill =>
    text.toLowerCase().includes(skill.toLowerCase())
  )
  return [...new Set(found)]
}

// Extraer posible nombre (primera línea no vacía)
export function extractName(text) {
  const lines = text.split('\n').filter(l => l.trim().length > 2)
  return lines[0]?.trim() || ''
}

// Extraer posible email
export function extractEmail(text) {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
  return match ? match[0] : ''
}

// Extraer posible teléfono
export function extractPhone(text) {
  const match = text.match(/(\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{2,4}/)
  return match ? match[0] : ''
}
