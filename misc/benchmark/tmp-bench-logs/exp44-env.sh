# Exp44 key export — values pulled from root workspace .env at runtime
for k in GEMINI_API_KEY GOOGLE_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY; do
  v=$(grep -m1 "^${k}=" /workspaces/ggui-workspace/.env | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
  [ -n "$v" ] && export "$k=$v"
done
