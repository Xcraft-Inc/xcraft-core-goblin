## 🎯 Objectifs

- Ce document doit concerner **uniquement le fonctionnement du hook beforePersistOnServer**
- Décrire en détail le fonctionnement de ce hook beforePersistOnServer
  - A quoi ça sert et pourquoi faire
  - Comment ça fonctionne (détails si pertinant)
  - On doit être capable de comprendre clairement les étapes
- Toujours fournir des diagrammes de séquence (mermaid) si nécessaire
- Ne **jamais écrire du code**, ce document doit uniquement expliquer le fonctionnement en français
- Ne pas expliquer des banalités
- Ne pas présenter les autres fonctionalités (qui ne concernent pas directement ce hook)
- Si le contexte contient un **README précédent** "## README précédent"
  - Mettre à jour le contenu markdown en effectuant une adaptation de la dernière génération.
  - Ajouter ce qui manque.
  - Supprimer ce qui n'existe plus.
  - Corriger ce qui a changé par rapport au code source.
  - Indiquer au bas du document qu'il s'agit d'une mise à jour et sans spécifier de date.

## 📑 Format attendu

Le README généré doit être en **Markdown** et suivre cette structure :

```markdown
# Synchronisation

## Aperçu

(Description concise haut-niveau du fonctionnement)

## Fonctionnement

(Explications du fonctionnement en respectant les objectifs, utiliser des diagrammes quand c'est pertinant, ...)
```

## Points d'attention particuliers

- **Cohérence technique** : Vérifie que les explications techniques correspondent exactement à ce qui est dans le code source.
- **Profondeur vs Clarté** : Balance la profondeur technique avec la clarté pour des lecteurs de différents niveaux.
- **Documentation des erreurs** : Si le module comporte une gestion d'erreurs spécifique, documente-la.

## Optimisation des tableaux pour GitHub

Pour rendre les tableaux plus lisibles sur GitHub:

1. **Éviter les tableaux pour les descriptions complexes** : Au lieu d'utiliser un tableau avec de nombreuses colonnes pour documenter les méthodes, opter pour une structure en liste avec des titres en gras.

2. **Pour les tableaux de configuration**, limiter la largeur des descriptions en utilisant des phrases concises ou en divisant les longues descriptions sur plusieurs lignes.

3. **Pour les énumérations longues**, utiliser des listes à puces plutôt que d'énumérer dans une cellule de tableau.
