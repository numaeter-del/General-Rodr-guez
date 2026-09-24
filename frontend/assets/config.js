/*
 * Configuración de la aplicación.
 *
 * API_URL: URL de la aplicación web de Google Apps Script (termina en /exec).
 *          Ver README.md → "Puesta en marcha".
 *          Si se deja vacía, la app funciona en MODO DEMO: los datos se guardan
 *          solo en este navegador y hay dos usuarios de prueba:
 *            carga    / demo1234  (perfil Carga)
 *            analisis / demo1234  (perfil Análisis)
 */
window.APP_CONFIG = {
  API_URL: '',
  NOMBRE_APP: 'Base Integral de Contribuyentes',
  ORGANISMO: 'Municipalidad de General Rodríguez',
};
