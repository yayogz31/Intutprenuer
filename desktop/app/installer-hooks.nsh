; Inturpreneur — limpieza total al desinstalar (nunca durante una actualización).
; Todo lo de la app vive en la carpeta de instalación: modelos, caché de la ventana y configuración.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    RMDir /r "$INSTDIR\models"
    RMDir /r "$INSTDIR\EBWebView"
    RMDir /r "$INSTDIR\tmp"
    Delete "$INSTDIR\config.json.tmp"
    ${If} ${FileExists} "$INSTDIR\config.json"
      ; solo se pregunta por el vocabulario, las tarjetas y las preferencias
      MessageBox MB_YESNO|MB_ICONQUESTION "Keep your vocabulary, cards and settings for a future installation?" /SD IDNO IDYES +2
      Delete "$INSTDIR\config.json"
    ${EndIf}
    RMDir "$INSTDIR"
  ${EndIf}
!macroend
