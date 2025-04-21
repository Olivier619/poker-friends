// eslint.config.mjs
// Version corrigée pour ignorer le dossier client

import js from "@eslint/js";        // Importe les règles de base ESLint pour JavaScript
import globals from "globals";    // Importe les définitions des globales (Node, navigateur, etc.)

// Exporte directement un tableau de configurations (format "flat config")
export default [
  {
    // Applique les règles de base recommandées pour JS
    // Note: "js/recommended" est souvent un alias plus moderne pour "eslint:recommended"
    ...js.configs.recommended,

    // Configuration spécifique pour les fichiers JS, MJS, CJS DANS le projet
    // (mais on va ignorer 'client/' juste après)
    files: ["**/*.{js,mjs,cjs}"],

    languageOptions: {
      ecmaVersion: "latest",        // Utiliser la syntaxe JavaScript la plus récente
      sourceType: "commonjs",       // Type de module par défaut pour le serveur (require/module.exports)
                                    // Le dossier 'client' (ESM) sera ignoré ci-dessous
      globals: {
        ...globals.node,           // Variables globales disponibles dans Node.js (console, process, etc.)
        // ...globals.browser,     // Ne pas décommenter si c'est la config racine pour le serveur
      }
    },

    // Règles spécifiques que tu pourrais vouloir ajouter ou modifier
    rules: {
      // Exemple : si tu veux imposer les points-virgules (le style "recommended" ne le fait pas)
      // "semi": ["error", "always"],

      // Exemple : Autoriser console.log (souvent désactivé par "recommended")
      "no-console": "off",

      // Exemple : si tu as des variables inutilisées pendant le développement
      "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }] // Avertissement au lieu d'erreur
    },

    // --- SECTION IMPORTANTE POUR IGNORER DES FICHIERS/DOSSIERS ---
    ignores: [
      "node_modules/**",      // Ignorer TOUJOURS node_modules
      "client/**",            // Ignorer TOUT le contenu du dossier 'client'
      "build/**",             // Ignorer le dossier de build client s'il est à la racine
      "dist/**"               // Ignorer un dossier de distribution potentiel
      // Ajoute d'autres motifs si nécessaire, ex: "coverage/**"
    ]
  }
  // Tu pourrais ajouter d'autres objets ici pour des configurations plus spécifiques
  // par exemple pour des fichiers de test, etc.
];