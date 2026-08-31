import { createTheme, Modal } from '@mantine/core';

// Ticket nuevo (post Release Candidate) — hallazgo real de una ronda de
// auto-revisión: el botón × de cerrar de TODO `Modal` de la app no tenía
// ningún nombre accesible. Confirmado leyendo el código fuente de
// Mantine (`CloseButton`/`ModalBaseCloseButton`): el único default es
// `variant: 'subtle'`, sin `aria-label` — y acá nunca se había
// configurado uno. Para un lector de pantalla, cada uno de los ~13
// modales de la app (`EditVariantModal`, `NuevoClienteModal`,
// `CloseSessionModal`, etc.) tenía un botón sin nombre, "botón" a
// secas, sin decir qué hace. `Modal.extend` lo arregla en un solo
// lugar en vez de repetir `closeButtonProps` en cada `<Modal>` — se
// aplica automáticamente a todos, presentes y futuros.
export const theme = createTheme({
  components: {
    Modal: Modal.extend({
      defaultProps: {
        closeButtonProps: { 'aria-label': 'Cerrar' },
      },
    }),
  },
});
