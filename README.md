# Affiche Fil Bleu

Affichage grand ecran pour suivre un trajet Fil Bleu a Tours avec :

- prochains trajets utiles
- heure d'arrivee finale
- bus, tram ou combinaison des deux
- perturbations, retards et manifestations
- mode veille hors horaires
- favoris
- mise a jour auto de l'app en CT, sans confirmation manuelle

## Repo

- GitHub : `https://github.com/Valentinblchd/affiche-filbleu`
- Branche : `main`

## Install rapide depuis l'hote Proxmox

Commande a lancer dans le shell Proxmox en `root` :

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Valentinblchd/affiche-filbleu/main/scripts/install-proxmox-host.sh)"
```

Par defaut, le script :

- cree un CT Debian 12
- met le nom `srv-filbleu`
- utilise le DHCP sur `vmbr0`
- installe l'app dans `/opt/affiche-filbleu`
- demarre le service `affiche-filbleu`
- affiche l'IP finale et l'URL

Exemple avec parametres forces :

```bash
CT_HOSTNAME=srv-filbleu CTID=317 TEMPLATE_STORAGE=local ROOTFS_STORAGE=local-lvm BRIDGE=vmbr0 bash -c "$(curl -fsSL https://raw.githubusercontent.com/Valentinblchd/affiche-filbleu/main/scripts/install-proxmox-host.sh)"
```

## Mise a jour sans login CT

Si tu n'as pas le login du CT, tu peux mettre a jour directement depuis le shell Proxmox :

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Valentinblchd/affiche-filbleu/main/scripts/update-proxmox-host.sh)"
```

Le script cherche par defaut le CT `srv-filbleu`, le demarre si besoin, puis relance l'install/update dedans.

Exemple avec un CTID force :

```bash
CTID=317 bash -c "$(curl -fsSL https://raw.githubusercontent.com/Valentinblchd/affiche-filbleu/main/scripts/update-proxmox-host.sh)"
```

## Mise a jour depuis le CT

Si tu as acces au shell du CT :

```bash
APP_REPO_URL=https://github.com/Valentinblchd/affiche-filbleu.git bash <(curl -fsSL https://raw.githubusercontent.com/Valentinblchd/affiche-filbleu/main/scripts/install-ct.sh)
```

Par defaut, l'installation CT active maintenant :

- `TZ=Europe/Paris` pour eviter les trajets decales d'une heure
- la verification auto des nouvelles versions
- l'application auto des mises a jour sans popup ni confirmation
- le redemarrage du service apres mise a jour

## Cache actuel

Oui, il y a deja un cache cote serveur pour eviter de surcharger Fil Bleu inutilement.

- reseau Fil Bleu (`init-application`) : `6 h`
- perturbations : `2 min`
- geocodage et reverse geocodage : `5 min`
- horaires temps reel : `30 s`
- horaires theoriques / timetable : `6 h`

Point important :

- le backend met en cache les appels utiles a Fil Bleu et aux adresses
- le front et les fichiers statiques sont servis en `no-store` volontairement

Donc :

- tu limites la charge sur les APIs externes
- mais tu ne gardes pas une vieille interface en cache quand l'app est mise a jour

## Comment l'app recupere les donnees

Le serveur appelle :

- `https://filbleu.latitude-cartagene.com/api/init-application`
- `https://filbleu.latitude-cartagene.com/api/autocomplete`
- `https://filbleu.latitude-cartagene.com/api/itinerary`
- `https://filbleu.latitude-cartagene.com/api/disruptions`
- `https://filbleu.latitude-cartagene.com/api/schedules`
- `https://api-adresse.data.gouv.fr/search/`
- `https://api-adresse.data.gouv.fr/reverse/`

## Scripts utiles

- `scripts/install-proxmox-host.sh` : cree le CT depuis l'hote Proxmox
- `scripts/update-proxmox-host.sh` : met a jour depuis l'hote Proxmox sans login CT
- `scripts/install-ct.sh` : installe ou met a jour depuis le shell du CT
- `scripts/check-update.sh` : verifie si une nouvelle version est disponible
- `scripts/apply-update.sh` : applique la mise a jour dans le CT
